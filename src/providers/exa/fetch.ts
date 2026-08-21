/**
 * Exa implementation of the standard `FetchProvider`.
 *
 * `fetch()` invokes the `web_fetch_exa` tool on the Exa MCP server
 * (singleton client from `./client.js`), maps the standard fetch options
 * (`url`, `maxCharacters` default 5000) to the tool arguments, honors
 * caller cancellation (`signal.aborted`) plus an internal request timeout,
 * and normalizes the raw Exa payload into the standard `FetchResponse` with
 * clean Markdown content.
 *
 * A single `string` URL returns a single `FetchResponse`; a `string[]` is
 * processed concurrently via `Promise.allSettled` and returns one
 * `FetchResponse` per URL, with a fallback error response for any URL that
 * fails.
 *
 * The MCP `callTool` invocation is wrapped in `withRetry` so transient
 * network failures (5xx, connection resets) are retried with exponential
 * backoff, and thrown errors are re-thrown masked via
 * `maskError`. Extracted content is truncated with the
 * semantic `truncateMarkdown` utility.
 */

import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  FetchOptions,
  FetchProvider,
  FetchResponse,
} from "../types.js";
import type { ExaFetchResponseRaw } from "./types.js";
import { getExaClient, maskError } from "./client.js";
import { withRetry } from "../../utils/retry.js";
import { truncateMarkdown } from "../../utils/markdown.js";

/** Name of the Exa MCP fetch tool. */
export const EXA_FETCH_TOOL = "web_fetch_exa";

/** Default maximum content length in characters (default 5000). */
export const EXA_FETCH_DEFAULT_MAX_CHARACTERS = 5_000;

/** Default request timeout in milliseconds (20s). */
export const EXA_FETCH_DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Resolve the fetch request timeout in milliseconds.
 *
 * Overridable via `EXA_FETCH_TIMEOUT_MS` (used by tests); the default is
 * `EXA_FETCH_DEFAULT_TIMEOUT_MS`.
 */
export function getExaFetchTimeoutMs(): number {
  const raw = process.env.EXA_FETCH_TIMEOUT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : EXA_FETCH_DEFAULT_TIMEOUT_MS;
}

/**
 * Validate and normalize the fetch URL.
 *
 * The URL must be a fully-formed valid `http://` or `https://` URL; HTTP
 * URLs are automatically upgraded to HTTPS. Throws a descriptive error for
 * malformed URLs or unsupported protocols.
 */
export function normalizeFetchUrl(url: string): string {
  if (url.startsWith("http://")) {
    return url.replace(/^http:/, "https:");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `Exa fetch requires a fully-formed http(s) URL, got: "${url}"`
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Exa fetch requires an http(s) URL, got: "${url}"`
    );
  }
  return url;
}

/**
 * Narrow the `callTool` outcome to a standard `CallToolResult` (the SDK
 * also models a task-based `{ toolResult }` outcome in the union).
 */
function isCallToolResult(value: unknown): value is CallToolResult {
  return typeof value === "object" && value !== null && "content" in value;
}

/**
 * Parse Exa fetch results from human-readable text / Markdown output.
 *
 * The Exa MCP `web_fetch_exa` tool returns Markdown text starting with
 * `# <Title>\nURL: <url>\n\n<Content>`.
 */
export function parseTextFetch(
  text: string,
  fallbackUrl: string
): ExaFetchResponseRaw | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return null;
  }
  const lines = trimmed.split("\n");
  let title: string | undefined;
  let url = fallbackUrl;
  let bodyStartIndex = 0;

  if (lines.length > 0 && lines[0].startsWith("# ")) {
    title = lines[0].slice(2).trim();
    bodyStartIndex = 1;
  }
  if (
    lines.length > bodyStartIndex &&
    lines[bodyStartIndex].startsWith("URL: ")
  ) {
    const parsedUrl = lines[bodyStartIndex].slice("URL: ".length).trim();
    if (parsedUrl) {
      url = parsedUrl;
    }
    bodyStartIndex++;
  }
  const content = lines.slice(bodyStartIndex).join("\n").trim();
  if (!content && !title) {
    return null;
  }
  return {
    url: url || fallbackUrl,
    title: title || undefined,
    content: content || trimmed,
  };
}

/**
 * Extract the raw fetch payload from a `web_fetch_exa` tool response.
 *
 * Supports both JSON payloads (`{ "url", "title", "content", ... }`) and
 * clean Markdown text blocks as returned by Exa MCP. Throws a descriptive
 * error when the tool reports an error or no parseable content is present.
 */
export function extractRawFetch(
  result: CallToolResult,
  fallbackUrl: string
): ExaFetchResponseRaw {
  if (result.isError) {
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    throw new Error(`Exa fetch failed: ${text.trim() || "unknown tool error"}`);
  }

  for (const block of result.content) {
    if (block.type !== "text" || !block.text) {
      continue;
    }

    // 1. Try JSON parsing
    try {
      const parsed: unknown = JSON.parse(block.text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as ExaFetchResponseRaw).content === "string"
      ) {
        return parsed as ExaFetchResponseRaw;
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as { results?: unknown[] }).results) &&
        (parsed as { results: unknown[] }).results.length > 0
      ) {
        const first = (parsed as { results: Array<{ url?: string; title?: string; text?: string }> }).results[0];
        if (first && (first.text || first.title)) {
          return {
            url: first.url || fallbackUrl,
            title: first.title,
            content: first.text || "",
          };
        }
      }
    } catch {
      // Not JSON; fallback to Markdown text parsing
    }

    // 2. Try Markdown text parsing
    const parsedFromText = parseTextFetch(block.text, fallbackUrl);
    if (parsedFromText !== null && parsedFromText.content) {
      return parsedFromText;
    }
  }
  throw new Error("Exa fetch returned no parseable content");
}

/**
 * Normalize the raw Exa fetch payload to the standard `FetchResponse`,
 * applying semantic Markdown truncation at `maxCharacters` so code blocks
 * and links are cut cleanly.
 */
function toFetchResponse(
  url: string,
  raw: ExaFetchResponseRaw,
  maxCharacters: number
): FetchResponse {
  const truncated = raw.truncated === true || raw.content.length > maxCharacters;
  const markdown = truncateMarkdown(raw.content, maxCharacters);
  return {
    url,
    title: raw.title,
    content: markdown,
    provider: "exa",
    metadata: {
      maxCharacters,
      truncated,
    },
  };
}

/**
 * Fetch a single URL via the `web_fetch_exa` MCP tool.
 *
 * The `callTool` invocation is wrapped in `withRetry` so
 * transient failures are retried with exponential backoff; the retry loop
 * stops immediately when the internal controller signal aborts (caller
 * cancellation or request timeout). Thrown errors are re-thrown masked via
 * `maskError` so credentials never leak.
 */
async function fetchSingle(
  rawUrl: string,
  options?: FetchOptions,
  signal?: AbortSignal
): Promise<FetchResponse> {
  if (signal?.aborted) {
    throw new Error("Exa fetch aborted before start");
  }

  const normalizedUrl = normalizeFetchUrl(rawUrl);
  const maxCharacters =
    typeof options?.maxCharacters === "number" && options.maxCharacters > 0
      ? Math.floor(options.maxCharacters)
      : EXA_FETCH_DEFAULT_MAX_CHARACTERS;

  // Combine caller cancellation with an internal request timeout.
  const controller = new AbortController();
  const timeoutMs = getExaFetchTimeoutMs();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`Exa fetch timed out after ${timeoutMs}ms`)
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
          {
            name: EXA_FETCH_TOOL,
            arguments: { urls: [normalizedUrl], maxCharacters },
          },
          CallToolResultSchema,
          { signal: controller.signal, timeout: timeoutMs }
        );
        if (!isCallToolResult(raw)) {
          throw new Error("Exa fetch returned an unexpected tool result");
        }
        return raw;
      },
      { signal: controller.signal }
    );
    return toFetchResponse(
      normalizedUrl,
      extractRawFetch(result, normalizedUrl),
      maxCharacters
    );
  } catch (error) {
    if (signal?.aborted) {
      throw new Error("Exa fetch aborted");
    }
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    throw maskError(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * The Exa standard fetch provider.
 *
 * Works in both authentication modes: with a resolved API key (attached to
 * the MCP endpoint) or in public free mode without a key.
 *
 * Accepts a single URL (`string`) or a batch (`string[]`): the batch is
 * processed concurrently via `Promise.allSettled` and one
 * `FetchResponse` is returned per URL — a fallback error response for any
 * URL that failed, so one bad page never sinks the whole batch.
 */
export const exaFetchProvider: FetchProvider = {
  id: "exa",
  name: "Exa",
  description:
    "Clean Markdown page extraction via the Exa MCP server (web_fetch_exa)",
  supportsApiKey: true,
  requiresApiKey: false,

  async fetch(
    url: string | string[],
    options?: FetchOptions,
    signal?: AbortSignal
  ): Promise<FetchResponse | FetchResponse[]> {
    if (Array.isArray(url)) {
      if (url.length === 0) {
        return [];
      }
      const settled = await Promise.allSettled(
        url.map((singleUrl) => fetchSingle(singleUrl, options, signal))
      );
      return settled.map((outcome, index): FetchResponse => {
        if (outcome.status === "fulfilled") {
          return outcome.value;
        }
        const reason = outcome.reason;
        const message =
          typeof reason === "object" &&
          reason !== null &&
          "message" in reason &&
          typeof (reason as { message?: unknown }).message === "string"
            ? (reason as { message: string }).message
            : "";
        return {
          url: url[index],
          title: "Error",
          content: `Failed to fetch ${url[index]}: ${message || String(reason)}`,
          provider: "exa",
        };
      });
    }
    return fetchSingle(url, options, signal);
  },
};
