/**
 * `web_deep_search` tool definition exposed to the LLM.
 *
 * Optional tool (disabled by default, enabled with `/ws deep on`). TypeBox
 * schema with `query` (string), `numSources` (number, optional, default 5)
 * and `includeText` (boolean, optional, default true), plus `numResults`,
 * `category` and `additionalQueries` kept as optional fields for backwards
 * compatibility, and the fixed LLM description, prompt snippet and prompt
 * guidelines. `execute` resolves the active `DeepSearchProvider` from the
 * `ProviderRegistry` using the provider id stored in the `deepSearch`
 * section of the extension config, delegates to `provider.answer` when
 * available (otherwise `provider.deepSearch`), and returns the formatted
 * synthesized output with citations wrapped in `<web_content>` isolation
 * blocks.
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
import type { DeepSearchResponse } from "../providers/types.js";
import { SECURITY_NOTICE_PREFIX, wrapWebContent } from "../utils/security.js";
import { renderCall, renderTruncatedResult } from "./renderers.js";

/** Default number of reference sources consulted. */
export const WEB_DEEP_SEARCH_DEFAULT_NUM_SOURCES = 5;

/** Default number of results requested per deep-search query. */
export const WEB_DEEP_SEARCH_DEFAULT_NUM_RESULTS = 10;

/**
 * TypeBox parameter schema of the `web_deep_search` tool:
 * - `query` (string, required): in-depth research query or question.
 * - `numSources` (number, optional, default 5): number of reference sources
 *   to consult.
 * - `includeText` (boolean, optional, default true): whether to include
 *   text extracts from the cited sources.
 * - `numResults` (number, optional, default 10): desired result count per
 *   query (backwards compatibility).
 * - `category` (string, optional): content category filter (backwards
 *   compatibility).
 * - `additionalQueries` (array of strings, optional): complementary
 *   sub-queries executed in parallel (backwards compatibility).
 */
export const webDeepSearchSchema = Type.Object({
  query: Type.String({
    description: "In-depth research query or question to answer",
  }),
  numSources: Type.Optional(
    Type.Number({
      description: `Number of reference sources to consult (default: ${WEB_DEEP_SEARCH_DEFAULT_NUM_SOURCES})`,
    })
  ),
  includeText: Type.Optional(
    Type.Boolean({
      description:
        "Whether to include text extracts from cited sources (default: true)",
    })
  ),
  numResults: Type.Optional(
    Type.Number({
      description: `Number of results to return per query (default: ${WEB_DEEP_SEARCH_DEFAULT_NUM_RESULTS})`,
    })
  ),
  category: Type.Optional(
    Type.String({
      description:
        "Optional content category filter, e.g. 'company', 'research paper', 'news', 'github', 'pdf', 'tweet'",
    })
  ),
  additionalQueries: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional complementary sub-queries executed in parallel for broader coverage",
    })
  ),
});

/** Validated parameter type of the `web_deep_search` tool. */
export type WebDeepSearchParams = Static<typeof webDeepSearchSchema>;

/**
 * One-line snippet for the Available tools section of the default system
 * prompt.
 */
export const WEB_DEEP_SEARCH_PROMPT_SNIPPET =
  "In-depth web investigation with direct, source-grounded answers and citations";

/**
 * Guideline bullets appended to the default system prompt Guidelines
 * section while `web_deep_search` is active.
 */
export const WEB_DEEP_SEARCH_PROMPT_GUIDELINES: readonly string[] = [
  "Use web_deep_search for complex questions that require multi-source synthesis, deep verification, or direct comprehensive answers with citations.",
];

/**
 * Full description sent to the LLM.
 */
export const WEB_DEEP_SEARCH_DESCRIPTION =
  "Perform an in-depth web investigation and direct question-answering with synthesized answers grounded in authoritative sources. Use this for complex questions that require multi-source synthesis, deep verification, or direct comprehensive answers with citations.";

/**
 * Format a `DeepSearchResponse` into the structured plain-text output
 * returned to the model: the security notice prefix, a header with
 * query/provider/count, the synthesized direct answer (when reported in
 * `metadata.answer`) wrapped in a `<web_content title="Synthesized
 * Answer">` block, the executed sub-queries when reported, and one numbered
 * block per cited source with title, URL, optional publication data and the
 * highlights/text excerpt wrapped in a `<web_content url="..." title="..."
 * domain="...">` isolation block.
 */
export function formatDeepSearchResults(
  response: DeepSearchResponse
): string {
  if (response.results.length === 0) {
    return [
      SECURITY_NOTICE_PREFIX,
      `No deep search results found for "${response.query}".`,
    ].join("\n");
  }

  const header = `Deep search results for "${response.query}" (provider: ${response.provider}, ${response.results.length} results):`;
  const lines: string[] = [SECURITY_NOTICE_PREFIX, header];
  if (
    response.subQueriesExecuted !== undefined &&
    response.subQueriesExecuted.length > 0
  ) {
    lines.push(`Sub-queries executed: ${response.subQueriesExecuted.join(", ")}`);
  }

  const answer = response.metadata?.answer;
  if (typeof answer === "string" && answer.length > 0) {
    lines.push(
      "",
      wrapWebContent({ content: answer, title: "Synthesized Answer" })
    );
  }
  lines.push("");

  const blocks = response.results.map((item, index) => {
    const blockLines: string[] = [`${index + 1}. ${item.title}`, `   URL: ${item.url}`];
    const meta: string[] = [];
    if (item.publishedDate !== undefined) {
      meta.push(`Published: ${item.publishedDate}`);
    }
    if (item.author !== undefined) {
      meta.push(`Author: ${item.author}`);
    }
    if (meta.length > 0) {
      blockLines.push(`   ${meta.join(" | ")}`);
    }
    const excerpt: string[] = [];
    if (item.highlights !== undefined && item.highlights.length > 0) {
      excerpt.push(`Highlights: ${item.highlights.join("; ")}`);
    }
    if (item.text !== undefined) {
      excerpt.push(item.text);
    }
    if (excerpt.length > 0) {
      blockLines.push(
        wrapWebContent({
          content: excerpt.join("\n"),
          url: item.url,
          title: item.title,
        })
      );
    }
    return blockLines.join("\n");
  });

  return [...lines, ...blocks].join("\n");
}

/** Options for {@link createWebDeepSearchTool}. */
export interface WebDeepSearchToolOptions {
  /** Config reader; defaults to the real `getConfig`. */
  getConfig?: () => Promise<PiWebScoutConfig>;
}

/**
 * Create the `web_deep_search` `ToolDefinition`.
 *
 * `execute` reads the extension config to find the active `deepSearch`
 * provider id, resolves it through the given `ProviderRegistry` (which
 * throws a descriptive error for unknown ids or unsupported capabilities),
 * delegates to `DeepSearchProvider.answer` when available
 * (otherwise `DeepSearchProvider.deepSearch`) honoring the caller's
 * `AbortSignal`, and returns the formatted synthesized output with the raw
 * `DeepSearchResponse` as `details` for UI rendering.
 */
export function createWebDeepSearchTool(
  registry: ProviderRegistry,
  options: WebDeepSearchToolOptions = {}
): ToolDefinition<typeof webDeepSearchSchema, DeepSearchResponse> {
  const getConfigFn = options.getConfig ?? getConfig;

  return {
    name: TOOL_IDS.deepSearch,
    label: TOOL_IDS.deepSearch,
    description: WEB_DEEP_SEARCH_DESCRIPTION,
    promptSnippet: WEB_DEEP_SEARCH_PROMPT_SNIPPET,
    promptGuidelines: [...WEB_DEEP_SEARCH_PROMPT_GUIDELINES],
    parameters: webDeepSearchSchema,
    renderCall: renderCall(TOOL_IDS.deepSearch),
    renderResult: renderTruncatedResult,
    async execute(
      _toolCallId: string,
      params: WebDeepSearchParams,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<DeepSearchResponse> | undefined,
      _ctx: ExtensionContext
    ): Promise<
      {
        content: { type: "text"; text: string }[];
        details: DeepSearchResponse;
      }
    > {
      const config = await getConfigFn();
      const provider = registry.getDeepSearchProvider(
        config.deepSearch.provider
      );
      const response =
        typeof provider.answer === "function"
          ? await provider.answer(
              params.query,
              {
                numSources:
                  params.numSources ?? WEB_DEEP_SEARCH_DEFAULT_NUM_SOURCES,
                includeText: params.includeText ?? true,
                numResults: params.numResults,
                category: params.category,
                additionalQueries: params.additionalQueries,
              },
              signal
            )
          : await provider.deepSearch(
              params.query,
              {
                numResults:
                  params.numResults ?? WEB_DEEP_SEARCH_DEFAULT_NUM_RESULTS,
                category: params.category,
                additionalQueries: params.additionalQueries,
              },
              signal
            );
      return {
        content: [{ type: "text", text: formatDeepSearchResults(response) }],
        details: response,
      };
    },
  };
}
