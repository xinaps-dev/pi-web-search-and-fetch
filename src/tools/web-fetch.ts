/**
 * `web_fetch` tool definition exposed to the LLM.
 *
 * TypeBox schema with `urls` (string or string[], required) and
 * `maxCharacters` (number, optional, default 5000), plus the fixed LLM
 * description, prompt snippet and prompt guidelines. `execute` resolves the
 * active `FetchProvider` from the `ProviderRegistry` using the provider id
 * stored in the `fetch` section of the extension config, delegates to it
 * with a normalized URL list, and returns the extracted Markdown content
 * wrapped in `<web_content>` isolation blocks.
 */

import { Type, type Static } from "typebox";
import type {
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getConfig } from "../config/index.js";
import type { PiWebScoutConfig } from "../config/types.js";
import { TOOL_IDS } from "../config/constants.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { FetchResponse } from "../providers/types.js";
import {
  SECURITY_NOTICE_PREFIX,
  wrapWebContent,
} from "../utils/security.js";
import { renderCall, renderTruncatedResult } from "./renderers.js";

/** Default maximum length of the extracted content per page. */
export const WEB_FETCH_DEFAULT_MAX_CHARACTERS = 5000;

/**
 * TypeBox parameter schema of the `web_fetch` tool:
 * - `urls` (string | string[], optional): one or multiple webpage URLs to
 *   fetch.
 * - `url` (string, optional): single-URL compatibility alias.
 * - `maxCharacters` (number, optional, default 5000): maximum length of the
 *   extracted content per page.
 */
export const webFetchSchema = Type.Object({
  urls: Type.Optional(
    Type.Union(
      [Type.Array(Type.String()), Type.String()],
      {
        description: "One or multiple webpage URLs to fetch",
      }
    )
  ),
  url: Type.Optional(
    Type.String({
      description: "Optional single URL for compatibility",
    })
  ),
  maxCharacters: Type.Optional(
    Type.Number({
      description: `Maximum length of extracted content per page (default: ${WEB_FETCH_DEFAULT_MAX_CHARACTERS})`,
    })
  ),
});

/** Validated parameter type of the `web_fetch` tool. */
export type WebFetchParams = Static<typeof webFetchSchema>;

/**
 * One-line snippet for the Available tools section of the default system
 * prompt.
 */
export const WEB_FETCH_PROMPT_SNIPPET =
  "Fetch full clean markdown content from one or multiple known webpage URLs";

/**
 * Guideline bullets appended to the default system prompt Guidelines
 * section while `web_fetch` is active.
 */
export const WEB_FETCH_PROMPT_GUIDELINES: readonly string[] = [
  "Use web_fetch to retrieve and analyze full content from one or multiple specific, known URLs (retrieval vs discovery).",
  "Pass 'urls' as a single string or an array of strings to batch-fetch multiple pages in a single call; each page is returned separately.",
];

/**
 * Full description sent to the LLM.
 */
export const WEB_FETCH_DESCRIPTION =
  "Read one or multiple webpage URLs and extract their full content as clean, readable markdown. Supports batch processing of multiple URLs in a single call. Use after web_search when highlights are insufficient or whenever you already have specific URLs to inspect.";

/**
 * Format one or more `FetchResponse` pages into the plain-text output
 * returned to the model: the security notice prefix, then one
 * `<web_content>` isolation block per page (or a per-page notice when no
 * content could be extracted).
 */
export function formatFetchResult(
  response: FetchResponse | FetchResponse[]
): string {
  const pages = Array.isArray(response) ? response : [response];
  const lines: string[] = [SECURITY_NOTICE_PREFIX];
  if (pages.length === 0) {
    lines.push("No web fetch results returned.");
    return lines.join("\n");
  }
  for (const page of pages) {
    if (page.content.length === 0) {
      lines.push(`No content could be extracted from "${page.url}".`);
      continue;
    }
    lines.push(
      wrapWebContent({
        content: page.content,
        url: page.url,
        title: page.title,
      })
    );
  }
  return lines.join("\n");
}

/** Options for {@link createWebFetchTool}. */
export interface WebFetchToolOptions {
  /** Config reader; defaults to the real `getConfig`. */
  getConfig?: () => Promise<PiWebScoutConfig>;
}

/**
 * Create the `web_fetch` `ToolDefinition`.
 *
 * `execute` reads the extension config to find the active `fetch` provider
 * id, resolves it through the given `ProviderRegistry` (which throws a
 * descriptive error for unknown ids or unsupported capabilities),
 * normalizes `params.urls` / `params.url` into a URL list, delegates to
 * `FetchProvider.fetch` honoring the caller's `AbortSignal`, and returns the
 * formatted output with the raw `FetchResponse` / `FetchResponse[]` as
 * `details` for UI rendering.
 */
export function createWebFetchTool(
  registry: ProviderRegistry,
  options: WebFetchToolOptions = {}
): ToolDefinition<
  typeof webFetchSchema,
  FetchResponse | FetchResponse[]
> {
  const getConfigFn = options.getConfig ?? getConfig;

  return {
    name: TOOL_IDS.fetch,
    label: TOOL_IDS.fetch,
    description: WEB_FETCH_DESCRIPTION,
    promptSnippet: WEB_FETCH_PROMPT_SNIPPET,
    promptGuidelines: [...WEB_FETCH_PROMPT_GUIDELINES],
    parameters: webFetchSchema,
    renderCall: renderCall(TOOL_IDS.fetch),
    renderResult: renderTruncatedResult,
    async execute(
      _toolCallId: string,
      params: WebFetchParams,
      signal: AbortSignal | undefined,
      _onUpdate:
        | AgentToolUpdateCallback<FetchResponse | FetchResponse[]>
        | undefined,
      _ctx: ExtensionContext
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: FetchResponse | FetchResponse[];
    }> {
      const config = await getConfigFn();
      const provider = registry.getFetchProvider(config.fetch.provider);
      const rawUrls: string | string[] | undefined =
        params.urls ?? params.url;
      if (rawUrls === undefined) {
        throw new Error(
          "web_fetch requires at least one URL: pass 'urls' (string or string[]) or 'url'."
        );
      }
      const targets: string[] = Array.isArray(rawUrls)
        ? rawUrls
        : [rawUrls];
      const result = await provider.fetch(
        targets,
        {
          maxCharacters:
            params.maxCharacters ?? WEB_FETCH_DEFAULT_MAX_CHARACTERS,
        },
        signal
      );
      const responses = Array.isArray(result) ? result : [result];
      return {
        content: [{ type: "text", text: formatFetchResult(responses) }],
        details: responses,
      };
    },
  };
}
