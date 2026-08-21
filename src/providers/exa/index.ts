/**
 * Exa provider module packaging.
 *
 * Exports the Exa `ProviderModule` with the triple capability
 * `["search", "fetch", "deep-search"]`, linking each declared capability
 * to its concrete implementation:
 * - "search"      → `exaSearchProvider`     (`./search.js`)
 * - "fetch"       → `exaFetchProvider`     (`./fetch.js`)
 * - "deep-search" → `exaDeepSearchProvider` (`./deep-search.js`)
 *
 * This is the single entry point used by the extension entry to register
 * Exa in the `ProviderRegistry`, and it re-exports the
 * implementations, the shared MCP client lifecycle helpers and the
 * Exa-specific types so consumers never reach into the submodules
 * directly.
 */

import type { ProviderModule } from "../types.js";
import { exaSearchProvider } from "./search.js";
import { exaFetchProvider } from "./fetch.js";
import { exaDeepSearchProvider } from "./deep-search.js";
import { createExaConfigModal } from "./ui.js";

/**
 * The Exa provider module.
 *
 * Exa implements all three capabilities through the shared Exa MCP
 * client (`./client.js`): standard search, clean Markdown fetch and
 * deep multi-query research (the latter requires the user's own API
 * key).
 */
export const exaProviderModule: ProviderModule = {
  id: "exa",
  name: "Exa",
  description:
    "Exa web provider: semantic search, clean Markdown fetch and deep " +
    "multi-query research via the Exa MCP server",
  capabilities: ["search", "fetch", "deep-search"],
  searchProvider: exaSearchProvider,
  fetchProvider: exaFetchProvider,
  deepSearchProvider: exaDeepSearchProvider,
  configure: async (ctx) => {
    await ctx.ui.custom((_tui, theme, _kb, done) =>
      createExaConfigModal(theme, {
        onSubmit: () => done(undefined),
        onCancel: () => done(undefined),
      })
    );
  },
};

export { exaSearchProvider } from "./search.js";
export { exaFetchProvider } from "./fetch.js";
export { exaDeepSearchProvider } from "./deep-search.js";
export { createExaConfigModal } from "./ui.js";
export { getExaClient, closeExaClient } from "./client.js";
export { EXA_SEARCH_TOOL, EXA_FIND_SIMILAR_TOOL } from "./search.js";
export { EXA_FETCH_TOOL } from "./fetch.js";
export { EXA_ANSWER_TOOL, EXA_DEEP_SEARCH_TOOL } from "./deep-search.js";

export type {
  ExaAnswerCitation,
  ExaAnswerOptions,
  ExaAnswerResponseRaw,
  ExaAnswerResultRaw,
  ExaCategory,
  ExaDeepSearchOptions,
  ExaDeepSearchResponseRaw,
  ExaDeepSearchResultRaw,
  ExaFetchOptions,
  ExaFetchResponseRaw,
  ExaFindSimilarOptions,
  ExaFindSimilarResponseRaw,
  ExaSearchFilters,
  ExaSearchOptions,
  ExaSearchResponseRaw,
  ExaSearchResultRaw,
} from "./types.js";
