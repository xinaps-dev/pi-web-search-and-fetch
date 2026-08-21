/**
 * Exa implementation of the standard `DeepSearchProvider`.
 *
 * `deepSearch()` performs deep multi-query research: it validates that a
 * valid Exa API key is available (deep search requires the user's own API
 * key, the public free mode is not supported), executes the main query and
 * every `additionalQueries` entry in parallel through the `web_search_exa`
 * tool on the Exa MCP server (singleton client from `./client.js`), and
 * synthesizes the per-query results into one structured `DeepSearchResponse`
 * with URL deduplication and `subQueriesExecuted` reporting.
 *
 * `answer()` attempts a direct synthesized answer through the
 * `web_answer_exa` tool; when the tool is unavailable or fails,
 * it transparently falls back to `deepSearch()` multi-source synthesis.
 *
 * Both methods honor `numSources` (default 5, mapped to the per-query result
 * count) and `includeText` (default true, whether source text excerpts are
 * included in the results).
 *
 * The MCP `callTool` invocations are wrapped in `withRetry` so transient
 * network failures (5xx, connection resets) are retried with exponential
 * backoff, and thrown errors are re-thrown masked via
 * `maskError`.
 */

import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  DeepSearchOptions,
  DeepSearchProvider,
  DeepSearchResponse,
} from "../types.js";
import type { ExaAnswerResponseRaw, ExaDeepSearchResultRaw } from "./types.js";
import { getExaClient, maskError } from "./client.js";
import { getExaApiKey } from "../../config/auth.js";
import { getConfig } from "../../config/index.js";
import { withRetry } from "../../utils/retry.js";
import { parseTextSearchResults } from "./search.js";

/** Name of the Exa MCP search tool reused for each deep-search query. */
export const EXA_DEEP_SEARCH_TOOL = "web_search_exa";

/** Name of the Exa MCP answer tool. */
export const EXA_ANSWER_TOOL = "web_answer_exa";

/** Default number of results per query. */
export const EXA_DEEP_SEARCH_DEFAULT_NUM_RESULTS = 10;

/** Default number of sources referenced by the answer endpoint (default 5). */
export const EXA_DEEP_SEARCH_DEFAULT_NUM_SOURCES = 5;

/** Default request timeout in milliseconds (60s). */
export const EXA_DEEP_SEARCH_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Resolve the deep-search request timeout in milliseconds.
 *
 * Overridable via `EXA_DEEP_SEARCH_TIMEOUT_MS` (used by tests); the
 * default is `EXA_DEEP_SEARCH_DEFAULT_TIMEOUT_MS`.
 */
export function getExaDeepSearchTimeoutMs(): number {
  const raw = process.env.EXA_DEEP_SEARCH_TIMEOUT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : EXA_DEEP_SEARCH_DEFAULT_TIMEOUT_MS;
}

/**
 * Resolve the number of results per query:
 * an explicit `numResults` wins, then `numSources` (the `web_deep_search`
 * parameter), then the default.
 */
function resolveNumResults(options?: DeepSearchOptions): number {
  if (typeof options?.numResults === "number" && options.numResults > 0) {
    return Math.floor(options.numResults);
  }
  if (typeof options?.numSources === "number" && options.numSources > 0) {
    return Math.floor(options.numSources);
  }
  return EXA_DEEP_SEARCH_DEFAULT_NUM_RESULTS;
}

/**
 * Build the ordered list of queries to run: the main query first, then
 * each non-empty `additionalQueries` entry, deduplicated case-insensitively.
 */
export function buildDeepSearchQueries(
  query: string,
  additionalQueries?: string[]
): string[] {
  const main = query.trim();
  const seen = new Set([main.toLowerCase()]);
  const queries: string[] = [main];
  for (const extra of additionalQueries ?? []) {
    const trimmed = extra.trim();
    const key = trimmed.toLowerCase();
    if (trimmed === "" || seen.has(key)) {
      continue;
    }
    seen.add(key);
    queries.push(trimmed);
  }
  return queries;
}

/**
 * Narrow the `callTool` outcome to a standard `CallToolResult` (the SDK
 * also models a task-based `{ toolResult }` outcome in the union).
 */
function isCallToolResult(value: unknown): value is CallToolResult {
  return typeof value === "object" && value !== null && "content" in value;
}

/**
 * Extract the raw result list from a `web_search_exa` tool response for one
 * deep-search query. The Exa MCP tool returns its payload as JSON inside a
 * text content block (either `{ "results": [...] }` or a bare array).
 * Throws a descriptive error when the tool reports an error.
 */
function extractRawResults(
  query: string,
  result: CallToolResult
): ExaDeepSearchResultRaw[] {
  if (result.isError) {
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    throw new Error(
      `Exa deep search failed for "${query}": ${
        text.trim() || "unknown tool error"
      }`
    );
  }

  for (const block of result.content) {
    if (block.type !== "text" || !block.text) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(block.text);
      const list = Array.isArray(parsed)
        ? parsed
        : (parsed as { results?: unknown } | null)?.results;
      if (Array.isArray(list)) {
        return list as ExaDeepSearchResultRaw[];
      }
    } catch {
      // Not a JSON payload; keep looking at the next block.
    }

    const parsedFromText = parseTextSearchResults(block.text);
    if (parsedFromText.length > 0) {
      return parsedFromText;
    }
  }
  throw new Error(
    `Exa deep search returned no parseable results for "${query}"`
  );
}

/**
 * Extract the raw answer payload from a `web_answer_exa` tool response.
 *
 * The Exa MCP tool returns its payload as JSON inside a text content block
 * (`{ "answer", "citations": [...] }`). Throws a descriptive error when the
 * tool reports an error or no parseable answer is present.
 */
function extractRawAnswer(result: CallToolResult): ExaAnswerResponseRaw {
  if (result.isError) {
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    throw new Error(`Exa answer failed: ${text.trim() || "unknown tool error"}`);
  }

  for (const block of result.content) {
    if (block.type !== "text") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(block.text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as ExaAnswerResponseRaw).answer === "string"
      ) {
        return parsed as ExaAnswerResponseRaw;
      }
    } catch {
      // Not a JSON payload; keep looking at the next block.
    }
  }
  throw new Error("Exa answer returned no parseable answer");
}

/**
 * Run a single deep-search query through the shared Exa MCP client.
 *
 * The `callTool` invocation is wrapped in `withRetry` so
 * transient failures are retried with exponential backoff; the retry loop
 * stops immediately when the combined caller/timeout signal aborts.
 */
async function runDeepSearchQuery(
  client: Client,
  query: string,
  numResults: number,
  category: string | undefined,
  signal: AbortSignal,
  timeoutMs: number
): Promise<ExaDeepSearchResultRaw[]> {
  const toolName =
    category !== undefined ? "web_search_advanced_exa" : EXA_DEEP_SEARCH_TOOL;
  const toolArguments: Record<string, unknown> = { query, numResults };
  if (category !== undefined) {
    const catMap: Record<string, string> = {
      research_paper: "publication",
      "research paper": "publication",
      personal_site: "personal site",
      "personal site": "personal site",
      financial_report: "financial report",
      "financial report": "financial report",
    };
    toolArguments.category = catMap[category] ?? category;
  }
  const result = await withRetry(
    async (): Promise<CallToolResult> => {
      const raw = await client.callTool(
        { name: toolName, arguments: toolArguments },
        CallToolResultSchema,
        { signal, timeout: timeoutMs }
      );
      if (!isCallToolResult(raw)) {
        throw new Error("Exa deep search returned an unexpected tool result");
      }
      return raw;
    },
    { signal }
  );
  return extractRawResults(query, result);
}

/**
 * Union two highlight lists, keeping the first occurrence order.
 */
function unionHighlights(
  a: string[] | undefined,
  b: string[] | undefined
): string[] | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  const merged = [...a];
  for (const highlight of b) {
    if (!merged.includes(highlight)) {
      merged.push(highlight);
    }
  }
  return merged;
}

/**
 * Merge one raw result into the deduplicated result map (keyed by URL).
 * The first occurrence of a URL wins for title/text/dates; highlights are
 * unioned across duplicates.
 */
function mergeDeepSearchResult(
  byUrl: Map<string, DeepSearchResponse["results"][number]>,
  raw: ExaDeepSearchResultRaw
): void {
  const key = raw.url.toLowerCase();
  const existing = byUrl.get(key);
  if (existing === undefined) {
    byUrl.set(key, {
      title: raw.title,
      url: raw.url,
      text: raw.text,
      highlights: raw.highlights,
      publishedDate: raw.publishedDate,
      author: raw.author,
    });
    return;
  }
  if (existing.text === undefined) {
    existing.text = raw.text;
  }
  existing.highlights = unionHighlights(existing.highlights, raw.highlights);
}

/**
 * The Exa deep-search provider.
 *
 * Unlike search and fetch, deep search requires the user's own Exa API key
 * ("Requires own API Key"); running without a key is rejected
 * with a descriptive notification instead of falling back to the public
 * free mode.
 */
export const exaDeepSearchProvider: DeepSearchProvider = {
  id: "exa",
  name: "Exa",
  description:
    "Deep multi-query web research via the Exa MCP server (requires its own API key)",
  supportsApiKey: true,
  requiresApiKey: true,

  async deepSearch(
    query: string,
    options?: DeepSearchOptions,
    signal?: AbortSignal
  ): Promise<DeepSearchResponse> {
    if (signal?.aborted) {
      throw new Error("Exa deep search aborted before start");
    }

    // Deep search requires a valid Exa API key: the
    // public free mode is not supported, so resolve the key up front and
    // fail with a descriptive notification when none is available.
    const config = await getConfig();
    const apiKey = getExaApiKey(config.providers.exa.useApiKey);
    if (apiKey === null) {
      throw new Error(
        "Exa deep search requires its own Exa API key (the public free " +
          "mode is not supported). Store a key with `/ws exa` or set the " +
          "EXA_API_KEY environment variable."
      );
    }

    const numResults = resolveNumResults(options);
    const includeText = options?.includeText ?? true;
    const category = options?.category;
    const queries = buildDeepSearchQueries(query, options?.additionalQueries);

    // Combine caller cancellation with an internal request timeout.
    const controller = new AbortController();
    const timeoutMs = getExaDeepSearchTimeoutMs();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(`Exa deep search timed out after ${timeoutMs}ms`)
        ),
      timeoutMs
    );
    timer.unref?.();
    const onCallerAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const client = await getExaClient();
      const settled = await Promise.allSettled(
        queries.map((q) =>
          runDeepSearchQuery(client, q, numResults, category, controller.signal, timeoutMs)
        )
      );

      // The main query (index 0) is required; a failure there fails the
      // whole deep search.
      const main = settled[0];
      if (main.status === "rejected") {
        throw main.reason;
      }

      // Structured synthesis: deduplicate by URL across all queries and
      // report which sub-queries succeeded / failed.
      const byUrl = new Map<string, DeepSearchResponse["results"][number]>();
      const subQueriesExecuted: string[] = [];
      const failedQueries: string[] = [];
      settled.forEach((outcome, index) => {
        const q = queries[index];
        if (outcome.status === "fulfilled") {
          subQueriesExecuted.push(q);
          for (const raw of outcome.value) {
            mergeDeepSearchResult(byUrl, raw);
          }
        } else {
          failedQueries.push(q);
        }
      });

      // `includeText: false` drops the source text excerpts.
      const merged = [...byUrl.values()];
      const results = includeText
        ? merged
        : merged.map(({ text: _omitted, ...rest }) => rest);

      return {
        query,
        results,
        subQueriesExecuted,
        provider: "exa",
        metadata: {
          numResults,
          includeText,
          ...(category !== undefined && { category }),
          ...(failedQueries.length > 0 && { failedQueries }),
        },
      };
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Exa deep search aborted");
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

  async answer(
    query: string,
    options?: DeepSearchOptions,
    signal?: AbortSignal
  ): Promise<DeepSearchResponse> {
    if (signal?.aborted) {
      throw new Error("Exa answer aborted before start");
    }

    // Answer synthesis requires a valid Exa API key, like deep search:
    // the public free mode is not supported, so resolve the key up front
    // and fail with a descriptive notification when none is available.
    const config = await getConfig();
    const apiKey = getExaApiKey(config.providers.exa.useApiKey);
    if (apiKey === null) {
      throw new Error(
        "Exa answer requires its own Exa API key (the public free " +
          "mode is not supported). Store a key with `/ws exa` or set the " +
          "EXA_API_KEY environment variable."
      );
    }

    const numSources =
      typeof options?.numSources === "number" && options.numSources > 0
        ? Math.floor(options.numSources)
        : EXA_DEEP_SEARCH_DEFAULT_NUM_SOURCES;
    const includeText = options?.includeText ?? true;

    // Combine caller cancellation with an internal request timeout.
    const controller = new AbortController();
    const timeoutMs = getExaDeepSearchTimeoutMs();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(`Exa answer timed out after ${timeoutMs}ms`)
        ),
      timeoutMs
    );
    timer.unref?.();
    const onCallerAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      let raw: ExaAnswerResponseRaw | null = null;
      try {
        raw = await withRetry(
          async (): Promise<ExaAnswerResponseRaw> => {
            const client = await getExaClient();
            const result = await client.callTool(
              {
                name: EXA_ANSWER_TOOL,
                arguments: { query, numSources, text: includeText },
              },
              CallToolResultSchema,
              { signal: controller.signal, timeout: timeoutMs }
            );
            if (!isCallToolResult(result)) {
              throw new Error(
                "Exa answer returned an unexpected tool result"
              );
            }
            return extractRawAnswer(result);
          },
          { signal: controller.signal }
        );
      } catch {
        // Caller cancellation or request timeout: propagate immediately.
        if (signal?.aborted) {
          throw new Error("Exa answer aborted");
        }
        if (controller.signal.aborted) {
          throw controller.signal.reason;
        }
        // The answer tool is unavailable or failed: fall back to deep
        // search synthesis below.
      }

      if (raw !== null) {
        return {
          query,
          results: (raw.citations ?? []).map((citation) => ({
            title: citation.title,
            url: citation.url,
            ...(includeText && citation.text !== undefined && {
              text: citation.text,
            }),
          })),
          provider: "exa",
          metadata: {
            numSources,
            includeText,
            answer: raw.answer,
          },
        };
      }

      // Fallback: multi-query deep search synthesis.
      const synthesized = await exaDeepSearchProvider.deepSearch(
        query,
        { ...options, numResults: numSources, includeText },
        controller.signal
      );
      return {
        ...synthesized,
        metadata: {
          ...synthesized.metadata,
          numSources,
          includeText,
        },
      };
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Exa answer aborted");
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
