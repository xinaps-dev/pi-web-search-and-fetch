/**
 * Standard provider interfaces and contracts for the pi-web-scout
 * multi-provider architecture.
 *
 * Each provider module can implement one, several or all three capabilities:
 * - "search": standard web search
 * - "fetch": page content extraction
 * - "deep-search": deep multi-query research
 *
 * The ProviderModule groups metadata, capabilities and the concrete
 * provider implementations together for registry registration.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** The three capabilities a provider can implement. */
export type ProviderCapability = "search" | "fetch" | "deep-search";

/** A single result item from a web search. */
export interface SearchResultItem {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  raw?: unknown;
}

/** Standardized response from a search provider. */
export interface SearchResponse {
  query: string;
  results: SearchResultItem[];
  provider: string;
  metadata?: Record<string, unknown>;
}

/** Standardized response from a fetch provider. */
export interface FetchResponse {
  url: string;
  title?: string;
  /** Content in Markdown or clean text. */
  content: string;
  provider: string;
  metadata?: Record<string, unknown>;
}

/** Standardized response from a deep-search provider. */
export interface DeepSearchResponse {
  query: string;
  results: Array<{
    title: string;
    url: string;
    text?: string;
    highlights?: string[];
    publishedDate?: string;
    author?: string;
  }>;
  subQueriesExecuted?: string[];
  provider: string;
  metadata?: Record<string, unknown>;
}

/** Options accepted by search providers. */
export interface SearchOptions {
  numResults?: number;
  category?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
  similarUrl?: string;
  [key: string]: unknown;
}

/** Options accepted by fetch providers. */
export interface FetchOptions {
  maxCharacters?: number;
  [key: string]: unknown;
}

/** Options accepted by deep-search providers. */
export interface DeepSearchOptions {
  numResults?: number;
  category?: string;
  numSources?: number;
  includeText?: boolean;
  additionalQueries?: string[];
  [key: string]: unknown;
}

/**
 * Contract for standard web search providers.
 */
export interface SearchProvider {
  id: string;
  name: string;
  description: string;
  supportsApiKey: boolean;
  requiresApiKey: boolean;
  search(
    query: string,
    options?: SearchOptions,
    signal?: AbortSignal
  ): Promise<SearchResponse>;
  /** Optional similar-content search by URL. */
  findSimilar?(
    url: string,
    options?: SearchOptions,
    signal?: AbortSignal
  ): Promise<SearchResponse>;
  configure?(ctx: ExtensionCommandContext): Promise<void>;
}

/**
 * Contract for page extraction/fetch providers.
 */
export interface FetchProvider {
  id: string;
  name: string;
  description: string;
  supportsApiKey: boolean;
  requiresApiKey: boolean;
  /**
   * Fetches one or more URLs. A single `string` URL returns a single
   * `FetchResponse`; a `string[]` returns one `FetchResponse` per URL.
   */
  fetch(
    url: string | string[],
    options?: FetchOptions,
    signal?: AbortSignal
  ): Promise<FetchResponse | FetchResponse[]>;
  configure?(ctx: ExtensionCommandContext): Promise<void>;
}

/**
 * Contract for deep / multi-query research providers.
 */
export interface DeepSearchProvider {
  id: string;
  name: string;
  description: string;
  supportsApiKey: boolean;
  requiresApiKey: boolean;
  deepSearch(
    query: string,
    options?: DeepSearchOptions,
    signal?: AbortSignal
  ): Promise<DeepSearchResponse>;
  /** Optional direct answer synthesis for a query. */
  answer?(
    query: string,
    options?: DeepSearchOptions,
    signal?: AbortSignal
  ): Promise<DeepSearchResponse>;
  configure?(ctx: ExtensionCommandContext): Promise<void>;
}

/**
 * Unified provider definition grouping metadata, capabilities and the
 * concrete provider implementations.
 */
export interface ProviderModule {
  id: string;
  name: string;
  description: string;
  /** Capabilities this provider supports, e.g. ["search", "fetch", "deep-search"]. */
  capabilities: ProviderCapability[];
  /** Present when the provider supports "search". */
  searchProvider?: SearchProvider;
  /** Present when the provider supports "fetch". */
  fetchProvider?: FetchProvider;
  /** Present when the provider supports "deep-search". */
  deepSearchProvider?: DeepSearchProvider;
  configure?(ctx: ExtensionCommandContext): Promise<void>;
}
