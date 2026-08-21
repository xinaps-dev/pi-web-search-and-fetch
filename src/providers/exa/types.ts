/**
 * Exa-specific types for the Exa API/MCP.
 *
 * These types describe the raw request/response shapes exchanged with the
 * Exa MCP tools (`web_search_exa`, `web_fetch_exa`) and the Exa REST API,
 * before they are normalized into the standard provider types declared in
 * `src/providers/types.ts`.
 *
 * This module is type-only and independent of the MCP client so the Exa
 * search, fetch and deep-search implementations share one
 * spelling per concept.
 */

/**
 * Exa search content categories.
 *
 * The documented values are the known Exa index categories. The trailing
 * `(string & {})` keeps the type compatible with the `string` `category`
 * parameter while still autocompleting the documented values, since the
 * list is non-exhaustive ("etc.").
 *
 * Both underscore and space variants are included because the Exa API
 * accepts either form for multi-word categories.
 */
export type ExaCategory =
  | "company"
  | "research_paper"
  | "research paper"
  | "news"
  | "pdf"
  | "github"
  | "tweet"
  | "personal_site"
  | "personal site"
  | "financial report"
  | "financial_report"
  | (string & {});

/**
 * Optional date filters for Exa search.
 */
export interface ExaSearchFilters {
  /** Only return results published on/after this date (ISO 8601). */
  startDate?: string;
  /** Only return results published on/before this date (ISO 8601). */
  endDate?: string;
}

/**
 * Request options for the Exa search MCP tool `web_search_exa`.
 */
export interface ExaSearchOptions {
  /** Number of results to return (default 8). */
  numResults?: number;
  /** Content category filter. */
  category?: ExaCategory;
  /** Optional date filters. */
  filters?: ExaSearchFilters;
  /** Restrict search to these domains. */
  includeDomains?: string[];
  /** Exclude results from these domains. */
  excludeDomains?: string[];
  /** Only return results published on/after this date (ISO 8601). */
  startPublishedDate?: string;
  /** Only return results published on/before this date (ISO 8601). */
  endPublishedDate?: string;
  /** If provided, trigger find-similar discovery for this URL. */
  similarUrl?: string;
}

/**
 * A single raw result item returned by Exa search.
 */
export interface ExaSearchResultRaw {
  title: string;
  url: string;
  /** Snippet or summary text. */
  text?: string;
  /** Publication date (ISO 8601). */
  publishedDate?: string;
  /** Author name. */
  author?: string;
  /** Relevance score when provided by Exa. */
  score?: number;
  /** Raw highlight snippets. */
  highlights?: string[];
}

/**
 * Raw response shape of the Exa search MCP tool `web_search_exa`.
 */
export interface ExaSearchResponseRaw {
  results: ExaSearchResultRaw[];
}

/**
 * Crawl / fetch options for the Exa fetch MCP tool `web_fetch_exa`.
 */
export interface ExaFetchOptions {
  /** Maximum characters to extract (default 15000). */
  maxCharacters?: number;
  /** Maximum crawl depth (Exa REST crawl API). */
  maxDepth?: number;
  /** Maximum number of pages to crawl (Exa REST crawl API). */
  maxPages?: number;
}

/**
 * Raw response shape of the Exa fetch MCP tool `web_fetch_exa`.
 */
export interface ExaFetchResponseRaw {
  url: string;
  title?: string;
  /** Clean Markdown content extracted from the page. */
  content: string;
  /** True when the content was truncated to `maxCharacters`. */
  truncated?: boolean;
}

/**
 * Request options for the Exa deep search.
 */
export interface ExaDeepSearchOptions {
  /** Number of results per query (default 10). */
  numResults?: number;
  /** Content category filter. */
  category?: ExaCategory;
  /** Additional parallel sub-queries. */
  additionalQueries?: string[];
}

/**
 * A single raw result item returned by Exa deep search.
 */
export interface ExaDeepSearchResultRaw {
  title: string;
  url: string;
  text?: string;
  highlights?: string[];
  publishedDate?: string;
  author?: string;
}

/**
 * Raw response shape of an Exa deep search run.
 */
export interface ExaDeepSearchResponseRaw {
  query: string;
  results: ExaDeepSearchResultRaw[];
  /** Sub-queries that were actually executed. */
  subQueriesExecuted?: string[];
}

/**
 * Options for the Exa find-similar endpoint.
 *
 * When `similarUrl` is present in `ExaSearchOptions`, the search module
 * maps the relevant fields into this shape before calling the Exa
 * find-similar API.
 */
export interface ExaFindSimilarOptions {
  /** Number of similar results to return. */
  numResults?: number;
  /** Restrict results to these domains. */
  includeDomains?: string[];
  /** Exclude results from these domains. */
  excludeDomains?: string[];
  /** Only return results published on/after this date (ISO 8601). */
  startPublishedDate?: string;
  /** Only return results published on/before this date (ISO 8601). */
  endPublishedDate?: string;
}

/**
 * Raw response shape of the Exa find-similar endpoint.
 */
export interface ExaFindSimilarResponseRaw {
  results: ExaSearchResultRaw[];
}

/**
 * Options for the Exa answer endpoint.
 */
export interface ExaAnswerOptions {
  /** The question or topic to answer. */
  query: string;
  /** Whether to include source text excerpts in citations. */
  text: boolean;
  /** Number of sources to reference (default 5). */
  numSources?: number;
}

/**
 * A single citation entry in an Exa answer response.
 */
export interface ExaAnswerCitation {
  /** Unique identifier for the source. */
  id: string;
  /** URL of the cited source. */
  url: string;
  /** Title of the cited source. */
  title: string;
  /** Optional text excerpt from the source. */
  text?: string;
}

/**
 * Raw result item from the Exa answer endpoint.
 */
export interface ExaAnswerResultRaw {
  answer: string;
  citations?: ExaAnswerCitation[];
}

/**
 * Raw response shape of the Exa answer endpoint.
 */
export interface ExaAnswerResponseRaw {
  answer: string;
  citations?: ExaAnswerCitation[];
}
