/**
 * `web_search` tool definition exposed to the LLM.
 *
 * TypeBox schema with `query` (string), `numResults` (number, optional,
 * default 10), `category` (optional enum), `includeDomains`,
 * `excludeDomains`, `startPublishedDate`, `endPublishedDate` and
 * `similarUrl` (all optional), plus the fixed LLM description, prompt
 * snippet and prompt guidelines. `execute` resolves the
 * active `SearchProvider` from the `ProviderRegistry` using the provider id
 * stored in the `search` section of the extension config, delegates to it,
 * and returns the formatted structured output with URLs and citations.
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
import type { SearchResponse } from "../providers/types.js";
import {
  SECURITY_NOTICE_PREFIX,
  wrapWebContent,
} from "../utils/security.js";
import { renderCall, renderTruncatedResult } from "./renderers.js";

/** Default number of results requested per search. */
export const WEB_SEARCH_DEFAULT_NUM_RESULTS = 10;

/**
 * TypeBox parameter schema of the `web_search` tool:
 * - `query` (string, required): semantic search query or keywords.
 * - `numResults` (number, optional, default 10): desired result count.
 * - `category` (enum, optional): thematic index filter.
 * - `includeDomains` (string[], optional): restrict search to domains.
 * - `excludeDomains` (string[], optional): exclude specific domains.
 * - `startPublishedDate` / `endPublishedDate` (ISO string, optional):
 *   publication date range filter.
 * - `similarUrl` (string, optional): triggers the transparent
 *   `findSimilar` dispatch.
 */
export const webSearchSchema = Type.Object({
  query: Type.String({
    description: "Semantic search query or keywords",
  }),
  numResults: Type.Optional(
    Type.Number({
      description: `Number of results to return (default: ${WEB_SEARCH_DEFAULT_NUM_RESULTS})`,
    })
  ),
  category: Type.Optional(
    Type.Union(
      [
        Type.Literal("company"),
        Type.Literal("research_paper"),
        Type.Literal("news"),
        Type.Literal("pdf"),
        Type.Literal("github"),
        Type.Literal("tweet"),
        Type.Literal("personal_site"),
      ],
      {
        description:
          "Optional category filter: 'company', 'research_paper', 'news', 'pdf', 'github', 'tweet', 'personal_site'",
      }
    )
  ),
  includeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional list of domains to restrict the search to",
    })
  ),
  excludeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional list of domains to exclude from the search",
    })
  ),
  startPublishedDate: Type.Optional(
    Type.String({
      description: "Optional ISO date: only return results published on or after this date",
    })
  ),
  endPublishedDate: Type.Optional(
    Type.String({
      description: "Optional ISO date: only return results published on or before this date",
    })
  ),
  similarUrl: Type.Optional(
    Type.String({
      description:
        "Optional URL: when provided, results similar to that URL are returned",
    })
  ),
});

/** Validated parameter type of the `web_search` tool. */
export type WebSearchParams = Static<typeof webSearchSchema>;

/**
 * One-line snippet for the Available tools section of the default system
 * prompt.
 */
export const WEB_SEARCH_PROMPT_SNIPPET =
  "Search the web for current information, news, facts, people, companies, or documentation";

/**
 * Guideline bullets appended to the default system prompt Guidelines
 * section while `web_search` is active.
 */
export const WEB_SEARCH_PROMPT_GUIDELINES: readonly string[] = [
  "Use web_search for discovering information, current events, recent documentation, or finding URLs beyond training data cutoff.",
  "Always use the current year when searching for recent developments or current versions.",
  "Use includeDomains / excludeDomains to restrict or filter results by domain, and startPublishedDate / endPublishedDate to filter by publication date.",
  "Tip: Use web_search to discover information, and web_fetch to retrieve full content from a specific known URL.",
];

/**
 * Full description sent to the LLM.
 */
export const WEB_SEARCH_DESCRIPTION =
  "Search the web for current information, news, facts, people, companies, or documentation about any topic. Returns clean search results with titles, URLs, highlights, and publish dates. For extracting full page content, follow up with web_fetch.";

/**
 * Format a `SearchResponse` into the structured plain-text output returned
 * to the model: the security notice prefix, a header with
 * query/provider/count and one numbered block per result with title, URL,
 * optional publication data and the snippet wrapped in a `<web_content>`
 * isolation block.
 */
export function formatSearchResults(response: SearchResponse): string {
  if (response.results.length === 0) {
    return [
      SECURITY_NOTICE_PREFIX,
      `No web search results found for "${response.query}".`,
    ].join("\n");
  }

  const header = `Web search results for "${response.query}" (provider: ${response.provider}, ${response.results.length} results):`;
  const blocks = response.results.map((item, index) => {
    const lines: string[] = [`${index + 1}. ${item.title}`, `   URL: ${item.url}`];
    const meta: string[] = [];
    if (item.publishedDate !== undefined) {
      meta.push(`Published: ${item.publishedDate}`);
    }
    if (item.author !== undefined) {
      meta.push(`Author: ${item.author}`);
    }
    if (meta.length > 0) {
      lines.push(`   ${meta.join(" | ")}`);
    }
    if (item.snippet !== undefined) {
      lines.push(
        wrapWebContent({
          content: item.snippet,
          url: item.url,
          title: item.title,
        })
      );
    }
    return lines.join("\n");
  });

  return [SECURITY_NOTICE_PREFIX, header, "", ...blocks].join("\n");
}

/** Options for {@link createWebSearchTool}. */
export interface WebSearchToolOptions {
  /** Config reader; defaults to the real `getConfig`. */
  getConfig?: () => Promise<PiWebScoutConfig>;
}

/**
 * Create the `web_search` `ToolDefinition`.
 *
 * `execute` reads the extension config to find the active `search` provider
 * id, resolves it through the given `ProviderRegistry` (which throws a
 * descriptive error for unknown ids or unsupported capabilities),
 * delegates to `SearchProvider.search` honoring the caller's `AbortSignal`,
 * and returns the formatted output with the raw `SearchResponse` as
 * `details` for UI rendering.
 */
export function createWebSearchTool(
  registry: ProviderRegistry,
  options: WebSearchToolOptions = {}
): ToolDefinition<typeof webSearchSchema, SearchResponse> {
  const getConfigFn = options.getConfig ?? getConfig;

  return {
    name: TOOL_IDS.search,
    label: TOOL_IDS.search,
    description: WEB_SEARCH_DESCRIPTION,
    promptSnippet: WEB_SEARCH_PROMPT_SNIPPET,
    promptGuidelines: [...WEB_SEARCH_PROMPT_GUIDELINES],
    parameters: webSearchSchema,
    renderCall: renderCall(TOOL_IDS.search),
    renderResult: renderTruncatedResult,
    async execute(
      _toolCallId: string,
      params: WebSearchParams,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<SearchResponse> | undefined,
      _ctx: ExtensionContext
    ): Promise<
      { content: { type: "text"; text: string }[]; details: SearchResponse }
    > {
      const config = await getConfigFn();
      const provider = registry.getSearchProvider(config.search.provider);
      const response = await provider.search(
        params.query,
        {
          numResults: params.numResults ?? WEB_SEARCH_DEFAULT_NUM_RESULTS,
          category: params.category,
          includeDomains: params.includeDomains,
          excludeDomains: params.excludeDomains,
          startPublishedDate: params.startPublishedDate,
          endPublishedDate: params.endPublishedDate,
          similarUrl: params.similarUrl,
        },
        signal
      );
      return {
        content: [{ type: "text", text: formatSearchResults(response) }],
        details: response,
      };
    },
  };
}
