/**
 * Exa implementation of the standard `SearchProvider`.
 *
 * `search()` invokes the `web_search_exa` tool on the Exa MCP server
 * (singleton client from `./client.js`), maps the standard search options
 * (`query`, `numResults` default 10, optional `category`, domain filters,
 * date filters) to the tool arguments, honors caller cancellation
 * (`signal.aborted`) plus an internal request timeout, and normalizes the
 * raw Exa results into the standard `SearchResponse`.
 *
 * `findSimilar()` invokes the `web_find_similar_exa` tool to discover URLs
 * similar to a given URL.
 *
 * Both methods wrap the MCP `callTool` invocation in `withRetry` so
 * transient network failures (5xx, connection resets) are retried with
 * exponential backoff, and re-throw masked errors via
 * `maskError`.
 */

import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  SearchOptions,
  SearchProvider,
  SearchResponse,
  SearchResultItem,
} from "../types.js";
import type { ExaSearchResultRaw } from "./types.js";
import { getExaClient, maskError } from "./client.js";
import { withRetry } from "../../utils/retry.js";

/** Name of the Exa MCP search tool. */
export const EXA_SEARCH_TOOL = "web_search_exa";

/** Name of the Exa MCP advanced search tool. */
export const EXA_SEARCH_ADVANCED_TOOL = "web_search_advanced_exa";

/** Name of the Exa MCP find-similar tool. */
export const EXA_FIND_SIMILAR_TOOL = "web_find_similar_exa";

/** Default number of results per search (default 10). */
export const EXA_SEARCH_DEFAULT_NUM_RESULTS = 10;

/** Default request timeout in milliseconds (15s). */
export const EXA_SEARCH_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Resolve the search request timeout in milliseconds.
 *
 * Overridable via `EXA_SEARCH_TIMEOUT_MS` (used by tests); the default is
 * `EXA_SEARCH_DEFAULT_TIMEOUT_MS`.
 */
export function getExaSearchTimeoutMs(): number {
  const raw = process.env.EXA_SEARCH_TIMEOUT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : EXA_SEARCH_DEFAULT_TIMEOUT_MS;
}

/**
 * Narrow the `callTool` outcome to a standard `CallToolResult` (the SDK
 * also models a task-based `{ toolResult }` outcome in the union).
 */
function isCallToolResult(value: unknown): value is CallToolResult {
  return typeof value === "object" && value !== null && "content" in value;
}

/**
 * Map a raw Exa search result item to the standard `SearchResultItem`.
 */
function toSearchResultItem(raw: ExaSearchResultRaw): SearchResultItem {
  return {
    title: raw.title,
    url: raw.url,
    snippet: raw.text,
    publishedDate: raw.publishedDate,
    author: raw.author,
    score: raw.score,
    raw,
  };
}

/**
 * Parse Exa search results from human-readable text / Markdown output.
 *
 * The Exa MCP `web_search_exa` tool returns results as formatted text
 * blocks separated by `---`, each with `Title:`, `URL:`, `Published:`,
 * `Author:`, and `Highlights:`.
 */
export function parseTextSearchResults(text: string): ExaSearchResultRaw[] {
  const blocks = text
    .split(/\n\s*---\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const results: ExaSearchResultRaw[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    let title = "";
    let url = "";
    let publishedDate: string | undefined;
    let author: string | undefined;
    const snippetLines: string[] = [];
    let inHighlights = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!inHighlights) {
        if (line.startsWith("Title: ")) {
          title = line.slice("Title: ".length).trim();
          continue;
        }
        if (line.startsWith("URL: ")) {
          url = line.slice("URL: ".length).trim();
          continue;
        }
        if (line.startsWith("Published: ")) {
          const val = line.slice("Published: ".length).trim();
          if (val && val !== "N/A") {
            publishedDate = val;
          }
          continue;
        }
        if (line.startsWith("Author: ")) {
          const val = line.slice("Author: ".length).trim();
          if (val && val !== "N/A") {
            author = val;
          }
          continue;
        }
        if (line.startsWith("Highlights:")) {
          inHighlights = true;
          continue;
        }
      }
      if (inHighlights) {
        snippetLines.push(line);
      }
    }

    if (url || title) {
      const snippet = snippetLines.join("\n").trim();
      results.push({
        title: title || url,
        url: url || "",
        text: snippet || undefined,
        publishedDate,
        author,
      });
    }
  }

  return results;
}

/**
 * Extract the raw result list from a `web_search_exa` or
 * `web_search_advanced_exa` tool response.
 *
 * Supports both JSON payloads (e.g. `{ "results": [...] }`) and plain
 * formatted text / Markdown blocks as returned by Exa MCP. Throws a
 * descriptive error when the tool reports an error or no parseable result
 * list is present.
 */
export function extractRawResults(result: CallToolResult): ExaSearchResultRaw[] {
  if (result.isError) {
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    throw new Error(
      `Exa search failed: ${text.trim() || "unknown tool error"}`
    );
  }

  for (const block of result.content) {
    if (block.type !== "text" || !block.text) {
      continue;
    }

    // 1. Try JSON parsing
    try {
      const parsed: unknown = JSON.parse(block.text);
      const list = Array.isArray(parsed)
        ? parsed
        : (parsed as { results?: unknown } | null)?.results;
      if (Array.isArray(list)) {
        return list as ExaSearchResultRaw[];
      }
    } catch {
      // Not JSON; fallback to text parsing
    }

    // 2. Try plain text / Markdown parsing
    const parsedFromText = parseTextSearchResults(block.text);
    if (parsedFromText.length > 0) {
      return parsedFromText;
    }
  }
  throw new Error("Exa search returned no parseable results");
}

/**
 * Build the tool name and arguments object from search options, mapping the
 * standard `SearchOptions` fields to Exa MCP tool parameters.
 */
export function buildSearchToolInvocation(
  query: string,
  options?: SearchOptions
): { toolName: string; arguments: Record<string, unknown> } {
  const numResults =
    typeof options?.numResults === "number" && options.numResults > 0
      ? Math.floor(options.numResults)
      : EXA_SEARCH_DEFAULT_NUM_RESULTS;

  const hasAdvanced =
    options?.category !== undefined ||
    (options?.includeDomains !== undefined && options.includeDomains.length > 0) ||
    (options?.excludeDomains !== undefined && options.excludeDomains.length > 0) ||
    options?.startPublishedDate !== undefined ||
    options?.endPublishedDate !== undefined;

  if (hasAdvanced) {
    const args: Record<string, unknown> = {
      query,
      numResults,
    };
    if (options?.category !== undefined) {
      const catMap: Record<string, string> = {
        research_paper: "publication",
        "research paper": "publication",
        personal_site: "personal site",
        "personal site": "personal site",
        financial_report: "financial report",
        "financial report": "financial report",
      };
      args.category = catMap[options.category] ?? options.category;
    }
    if (options?.includeDomains !== undefined && options.includeDomains.length > 0) {
      args.includeDomains = options.includeDomains;
    }
    if (options?.excludeDomains !== undefined && options.excludeDomains.length > 0) {
      args.excludeDomains = options.excludeDomains;
    }
    if (options?.startPublishedDate !== undefined) {
      args.startPublishedDate = options.startPublishedDate;
    }
    if (options?.endPublishedDate !== undefined) {
      args.endPublishedDate = options.endPublishedDate;
    }
    return { toolName: EXA_SEARCH_ADVANCED_TOOL, arguments: args };
  }

  return {
    toolName: EXA_SEARCH_TOOL,
    arguments: {
      query,
      numResults,
    },
  };
}

/**
 * Build the tool arguments object for find-similar from search options,
 * mapping the standard `SearchOptions` fields to Exa MCP find-similar
 * tool parameters.
 */
function buildFindSimilarToolArguments(
  url: string,
  options?: SearchOptions
): Record<string, unknown> {
  const numResults =
    typeof options?.numResults === "number" && options.numResults > 0
      ? Math.floor(options.numResults)
      : EXA_SEARCH_DEFAULT_NUM_RESULTS;

  const args: Record<string, unknown> = {
    url,
    numResults,
  };

  if (options?.includeDomains !== undefined) {
    args.includeDomains = options.includeDomains;
  }
  if (options?.excludeDomains !== undefined) {
    args.excludeDomains = options.excludeDomains;
  }
  if (options?.startPublishedDate !== undefined) {
    args.startPublishedDate = options.startPublishedDate;
  }
  if (options?.endPublishedDate !== undefined) {
    args.endPublishedDate = options.endPublishedDate;
  }
  if (options?.category !== undefined) {
    args.category = options.category;
  }

  return args;
}

/**
 * The Exa standard search provider.
 *
 * Works in both authentication modes: with a resolved API key (attached to
 * the MCP endpoint) or in public free mode without a key.
 */
export const exaSearchProvider: SearchProvider = {
  id: "exa",
  name: "Exa",
  description: "Semantic web search via the Exa MCP server (web_search_exa)",
  supportsApiKey: true,
  requiresApiKey: false,

  async search(
    query: string,
    options?: SearchOptions,
    signal?: AbortSignal
  ): Promise<SearchResponse> {
    // Transparent dispatch: if similarUrl is provided, delegate to findSimilar.
    if (options?.similarUrl) {
      return exaSearchProvider.findSimilar!(
        options.similarUrl,
        options,
        signal
      );
    }

    if (signal?.aborted) {
      throw new Error("Exa search aborted before start");
    }

    const { toolName, arguments: toolArguments } = buildSearchToolInvocation(
      query,
      options
    );
    const numResults = (toolArguments.numResults as number) ?? EXA_SEARCH_DEFAULT_NUM_RESULTS;

    // Combine caller cancellation with an internal request timeout.
    const controller = new AbortController();
    const timeoutMs = getExaSearchTimeoutMs();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(`Exa search timed out after ${timeoutMs}ms`)
        ),
      timeoutMs
    );
    timer.unref?.();
    const onCallerAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const result = await withRetry(
        async (): Promise<CallToolResult> => {
          const client = await getExaClient();
          const raw = await client.callTool(
            { name: toolName, arguments: toolArguments },
            CallToolResultSchema,
            { signal: controller.signal, timeout: timeoutMs }
          );
          if (!isCallToolResult(raw)) {
            throw new Error("Exa search returned an unexpected tool result");
          }
          return raw;
        },
        { signal: controller.signal }
      );

      const results = extractRawResults(result).map(toSearchResultItem);
      return {
        query,
        results,
        provider: "exa",
        metadata: {
          numResults,
          ...(options?.category !== undefined && {
            category: options.category,
          }),
        },
      };
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Exa search aborted");
      }
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      throw maskError(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  },

  async findSimilar(
    url: string,
    options?: SearchOptions,
    signal?: AbortSignal
  ): Promise<SearchResponse> {
    if (signal?.aborted) {
      throw new Error("Exa find-similar aborted before start");
    }

    const toolArguments = buildFindSimilarToolArguments(url, options);
    const numResults =
      (toolArguments.numResults as number) ?? EXA_SEARCH_DEFAULT_NUM_RESULTS;

    // Combine caller cancellation with an internal request timeout.
    const controller = new AbortController();
    const timeoutMs = getExaSearchTimeoutMs();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(`Exa find-similar timed out after ${timeoutMs}ms`)
        ),
      timeoutMs
    );
    timer.unref?.();
    const onCallerAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const result = await withRetry(
        async (): Promise<CallToolResult> => {
          const client = await getExaClient();
          const raw = await client.callTool(
            { name: EXA_FIND_SIMILAR_TOOL, arguments: toolArguments },
            CallToolResultSchema,
            { signal: controller.signal, timeout: timeoutMs }
          );
          if (!isCallToolResult(raw)) {
            throw new Error(
              "Exa find-similar returned an unexpected tool result"
            );
          }
          return raw;
        },
        { signal: controller.signal }
      );

      const results = extractRawResults(result).map(toSearchResultItem);
      return {
        query: url,
        results,
        provider: "exa",
        metadata: {
          numResults,
          similarUrl: url,
          ...(options?.category !== undefined && {
            category: options.category,
          }),
        },
      };
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Exa find-similar aborted");
      }
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      throw maskError(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  },
};
