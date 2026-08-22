import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiWebSearchAndFetchConfig } from "../src/config/types.js";
import { TOOL_IDS } from "../src/config/constants.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type {
  DeepSearchOptions,
  DeepSearchProvider,
  DeepSearchResponse,
  FetchOptions,
  FetchProvider,
  FetchResponse,
  ProviderModule,
  SearchOptions,
  SearchProvider,
  SearchResultItem,
  SearchResponse,
} from "../src/providers/types.js";
import {
  WEB_SEARCH_DEFAULT_NUM_RESULTS,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_PROMPT_GUIDELINES,
  WEB_SEARCH_PROMPT_SNIPPET,
  createWebSearchTool,
  formatSearchResults,
  webSearchSchema,
  type WebSearchParams,
} from "../src/tools/web-search.js";
import {
  WEB_FETCH_DEFAULT_MAX_CHARACTERS,
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_PROMPT_GUIDELINES,
  WEB_FETCH_PROMPT_SNIPPET,
  createWebFetchTool,
  formatFetchResult,
  webFetchSchema,
  type WebFetchParams,
} from "../src/tools/web-fetch.js";
import {
  WEB_DEEP_SEARCH_DEFAULT_NUM_RESULTS,
  WEB_DEEP_SEARCH_DESCRIPTION,
  WEB_DEEP_SEARCH_PROMPT_GUIDELINES,
  WEB_DEEP_SEARCH_PROMPT_SNIPPET,
  createWebDeepSearchTool,
  formatDeepSearchResults,
  webDeepSearchSchema,
  type WebDeepSearchParams,
} from "../src/tools/web-deep-search.js";
import { renderCall, renderTruncatedResult } from "../src/tools/renderers.js";
import {
  SECURITY_NOTICE_PREFIX,
  wrapWebContent,
} from "../src/utils/security.js";

/** Helper to extract plain text string from tool execution result content blocks. */
function extractTextContent(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

/** Sample search response generator. */
function sampleSearchResponse(
  provider = "exa",
  results?: SearchResultItem[]
): SearchResponse {
  return {
    query: "TypeScript 5.8 features",
    provider,
    results: results ?? [
      {
        title: "TypeScript 5.8 Announcement",
        url: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/",
        snippet: "Checks for return branches and granular node flags.",
        publishedDate: "2025-02-28",
        author: "TypeScript Team",
        score: 0.98,
      },
      {
        title: "TypeScript GitHub Repository",
        url: "https://github.com/microsoft/TypeScript",
        snippet: "TypeScript is a superset of JavaScript.",
      },
      {
        title: "Node.js Support Matrix",
        url: "https://nodejs.org/en/about/previous-releases",
      },
    ],
  };
}

/** Sample fetch response generator. */
function sampleFetchResponse(provider = "exa"): FetchResponse {
  return {
    url: "https://example.com/documentation",
    title: "Official Documentation",
    content: "# Documentation\n\nComprehensive API overview and guides.",
    provider,
    metadata: { fetchedAt: "2025-02-28T12:00:00Z" },
  };
}

/** Sample deep search response generator. */
function sampleDeepSearchResponse(provider = "exa"): DeepSearchResponse {
  return {
    query: "Quantum error correction surface codes",
    provider,
    subQueriesExecuted: [
      "Quantum error correction surface codes",
      "Surface code fault tolerance threshold",
      "Lattice surgery quantum circuits",
    ],
    results: [
      {
        title: "Surface Code Architectures",
        url: "https://arxiv.org/abs/1208.0928",
        text: "Surface codes offer high fault tolerance thresholds.",
        highlights: [
          "1% threshold under depolarizing noise",
          "2D nearest-neighbor coupling",
        ],
        publishedDate: "2012-08-06",
        author: "Austin G. Fowler et al.",
      },
      {
        title: "Lattice Surgery in Planar Codes",
        url: "https://arxiv.org/abs/1111.4022",
        text: "Universal quantum computation with planar codes using lattice surgery.",
        highlights: ["Eliminates routing overhead"],
      },
      {
        title: "Quantum Computing Overview",
        url: "https://example.org/qc-primer",
      },
    ],
    metadata: { synthesized: true },
  };
}

/** Generates standard test configuration. */
function createMockConfig(overrides?: Partial<PiWebSearchAndFetchConfig>): PiWebSearchAndFetchConfig {
  return {
    search: { enabled: true, provider: "exa" },
    fetch: { enabled: true, provider: "exa" },
    deepSearch: { enabled: false, provider: "exa" },
    providers: { exa: { useApiKey: true } },
    ...overrides,
  };
}

describe("src/tools (tests/tools.test.ts)", () => {
  // =========================================================================
  // 1. web_search Tool Execution and Output Formatting
  // =========================================================================
  describe("1. web_search Tool", () => {
    describe("Tool Definition & Metadata", () => {
      it("defines tool identity, schemas, prompt snippets, guidelines and renderers", () => {
        const registry = new ProviderRegistry();
        const tool = createWebSearchTool(registry);

        expect(tool.name).toBe(TOOL_IDS.search);
        expect(tool.label).toBe("web_search");
        expect(tool.parameters).toBe(webSearchSchema);
        expect(tool.description).toBe(WEB_SEARCH_DESCRIPTION);
        expect(tool.promptSnippet).toBe(WEB_SEARCH_PROMPT_SNIPPET);
        expect(tool.promptGuidelines).toEqual(WEB_SEARCH_PROMPT_GUIDELINES);
        expect(typeof tool.renderCall).toBe("function");
        expect(typeof tool.renderResult).toBe("function");
      });

      it("validates the TypeBox parameter schema requirements", () => {
        expect(Object.keys(webSearchSchema.properties)).toEqual([
          "query",
          "numResults",
          "category",
          "includeDomains",
          "excludeDomains",
          "startPublishedDate",
          "endPublishedDate",
          "similarUrl",
        ]);
        expect(webSearchSchema.required).toEqual(["query"]);
        expect(webSearchSchema.properties.query.type).toBe("string");
        expect(webSearchSchema.properties.numResults?.type).toBe("number");
        const category = webSearchSchema.properties.category as {
          anyOf: Array<{ const: string }>;
        };
        expect(category.anyOf.map((entry) => entry.const)).toEqual([
          "company",
          "research_paper",
          "news",
          "pdf",
          "github",
          "tweet",
          "personal_site",
        ]);
        expect(webSearchSchema.properties.includeDomains?.type).toBe("array");
        expect(webSearchSchema.properties.excludeDomains?.type).toBe("array");
        expect(webSearchSchema.properties.startPublishedDate?.type).toBe(
          "string"
        );
        expect(webSearchSchema.properties.endPublishedDate?.type).toBe(
          "string"
        );
        expect(webSearchSchema.properties.similarUrl?.type).toBe("string");
      });
    });

    describe("Execution & Parameter Delegation", () => {
      it("executes search with default numResults (10) and undefined filters", async () => {
        const searchMock = vi.fn(
          async (query: string, _opts?: SearchOptions): Promise<SearchResponse> =>
            sampleSearchResponse("exa")
        );
        const searchProvider: SearchProvider = {
          id: "exa",
          name: "Exa Search",
          description: "Exa search provider",
          supportsApiKey: true,
          requiresApiKey: false,
          search: searchMock,
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "exa",
          name: "Exa",
          description: "Exa provider module",
          capabilities: ["search"],
          searchProvider,
        });

        const tool = createWebSearchTool(registry, {
          getConfig: async () => createMockConfig({ search: { enabled: true, provider: "exa" } }),
        });

        const controller = new AbortController();
        const result = await tool.execute(
          "call-search-1",
          { query: "TypeScript 5.8 features" },
          controller.signal,
          undefined,
          undefined as unknown as ExtensionContext
        );

        expect(searchMock).toHaveBeenCalledTimes(1);
        expect(searchMock).toHaveBeenCalledWith(
          "TypeScript 5.8 features",
          {
            numResults: WEB_SEARCH_DEFAULT_NUM_RESULTS,
            category: undefined,
            includeDomains: undefined,
            excludeDomains: undefined,
            startPublishedDate: undefined,
            endPublishedDate: undefined,
            similarUrl: undefined,
          },
          controller.signal
        );

        expect(result.details).toEqual(sampleSearchResponse("exa"));
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe("text");
        const formatted = extractTextContent(result);
        expect(formatted).toContain('Web search results for "TypeScript 5.8 features" (provider: exa, 3 results):');
        expect(formatted).toContain("1. TypeScript 5.8 Announcement");
        expect(formatted).toContain("URL: https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/");
        expect(formatted).toContain("Published: 2025-02-28 | Author: TypeScript Team");
        expect(formatted).toContain("Checks for return branches and granular node flags.");
        expect(formatted).toContain("2. TypeScript GitHub Repository");
        expect(formatted).toContain("3. Node.js Support Matrix");
      });

      it("passes custom numResults and category to provider", async () => {
        const searchMock = vi.fn(
          async (query: string, opts?: SearchOptions): Promise<SearchResponse> => ({
            query,
            provider: "custom-search",
            results: [],
          })
        );
        const searchProvider: SearchProvider = {
          id: "custom-search",
          name: "Custom Search",
          description: "Custom search provider",
          supportsApiKey: false,
          requiresApiKey: false,
          search: searchMock,
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "custom-search",
          name: "Custom",
          description: "Custom module",
          capabilities: ["search"],
          searchProvider,
        });

        const tool = createWebSearchTool(registry, {
          getConfig: async () =>
            createMockConfig({ search: { enabled: true, provider: "custom-search" } }),
        });

        const params: WebSearchParams = {
          query: "AI agent frameworks",
          numResults: 5,
          category: "research_paper",
          includeDomains: ["arxiv.org"],
          startPublishedDate: "2024-01-01",
        };
        const result = await tool.execute(
          "call-search-2",
          params,
          undefined,
          undefined,
          undefined as unknown as ExtensionContext
        );

        expect(searchMock).toHaveBeenCalledWith(
          "AI agent frameworks",
          {
            numResults: 5,
            category: "research_paper",
            includeDomains: ["arxiv.org"],
            excludeDomains: undefined,
            startPublishedDate: "2024-01-01",
            endPublishedDate: undefined,
            similarUrl: undefined,
          },
          undefined
        );
        expect(extractTextContent(result)).toContain(SECURITY_NOTICE_PREFIX);
        expect(extractTextContent(result)).toContain(
          'No web search results found for "AI agent frameworks".'
        );
      });

      it("propagates AbortSignal to provider for cancellation support", async () => {
        const controller = new AbortController();
        const searchMock = vi.fn(
          async (_q: string, _opts?: SearchOptions, signal?: AbortSignal): Promise<SearchResponse> => {
            if (signal?.aborted) {
              throw new Error("Search aborted by user");
            }
            return sampleSearchResponse("exa");
          }
        );
        const searchProvider: SearchProvider = {
          id: "exa",
          name: "Exa",
          description: "Exa provider",
          supportsApiKey: true,
          requiresApiKey: false,
          search: searchMock,
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "exa",
          name: "Exa",
          description: "Exa",
          capabilities: ["search"],
          searchProvider,
        });

        const tool = createWebSearchTool(registry, {
          getConfig: async () => createMockConfig(),
        });

        controller.abort();
        await expect(
          tool.execute(
            "call-search-cancel",
            { query: "abort search" },
            controller.signal,
            undefined,
            undefined as unknown as ExtensionContext
          )
        ).rejects.toThrow("Search aborted by user");
      });

      it("propagates search provider runtime errors", async () => {
        const searchProvider: SearchProvider = {
          id: "exa",
          name: "Exa",
          description: "Exa",
          supportsApiKey: true,
          requiresApiKey: false,
          search: vi.fn().mockRejectedValue(new Error("Exa network error")),
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "exa",
          name: "Exa",
          description: "Exa",
          capabilities: ["search"],
          searchProvider,
        });

        const tool = createWebSearchTool(registry, {
          getConfig: async () => createMockConfig(),
        });

        await expect(
          tool.execute(
            "call-search-err",
            { query: "fail" },
            undefined,
            undefined,
            undefined as unknown as ExtensionContext
          )
        ).rejects.toThrow("Exa network error");
      });

      it("throws descriptive error when configured provider is not found or unsupported", async () => {
        const registry = new ProviderRegistry();
        const tool = createWebSearchTool(registry, {
          getConfig: async () => createMockConfig({ search: { enabled: true, provider: "non-existent" } }),
        });

        await expect(
          tool.execute(
            "call-search-missing",
            { query: "test" },
            undefined,
            undefined,
            undefined as unknown as ExtensionContext
          )
        ).rejects.toThrow(/Unknown provider "non-existent" for capability "search"/);
      });
    });

    describe("Output Formatting (formatSearchResults)", () => {
      it("formats multiple search results with index numbers, URLs, metadata and snippets", () => {
        const response: SearchResponse = {
          query: "vitest mocking",
          provider: "exa",
          results: [
            {
              title: "Vitest Mocks Guide",
              url: "https://vitest.dev/guide/mocking.html",
              author: "Vitest Core",
              publishedDate: "2024-10-01",
              snippet: "Guide on vi.fn and vi.mock.",
            },
            {
              title: "Vitest GitHub",
              url: "https://github.com/vitest-dev/vitest",
              snippet: "Next generation testing framework.",
            },
            {
              title: "Minimal Result",
              url: "https://example.com/min",
            },
          ],
        };

        const formatted = formatSearchResults(response);
        expect(formatted).toBe(
          [
            SECURITY_NOTICE_PREFIX,
            'Web search results for "vitest mocking" (provider: exa, 3 results):',
            "",
            "1. Vitest Mocks Guide",
            "   URL: https://vitest.dev/guide/mocking.html",
            "   Published: 2024-10-01 | Author: Vitest Core",
            wrapWebContent({
              content: "Guide on vi.fn and vi.mock.",
              url: "https://vitest.dev/guide/mocking.html",
              title: "Vitest Mocks Guide",
            }),
            "2. Vitest GitHub",
            "   URL: https://github.com/vitest-dev/vitest",
            wrapWebContent({
              content: "Next generation testing framework.",
              url: "https://github.com/vitest-dev/vitest",
              title: "Vitest GitHub",
            }),
            "3. Minimal Result",
            "   URL: https://example.com/min",
          ].join("\n")
        );
      });

      it("formats only publishedDate or only author when one is missing", () => {
        const response: SearchResponse = {
          query: "single meta",
          provider: "brave",
          results: [
            {
              title: "Only Date",
              url: "https://example.com/date",
              publishedDate: "2025-01-01",
            },
            {
              title: "Only Author",
              url: "https://example.com/author",
              author: "Alice",
            },
          ],
        };

        const formatted = formatSearchResults(response);
        expect(formatted).toContain("Published: 2025-01-01");
        expect(formatted).toContain("Author: Alice");
        expect(formatted).not.toContain(" | Author: undefined");
      });

      it("returns clear message when results list is empty", () => {
        const formatted = formatSearchResults({
          query: "non-existent-topic-xyz-123",
          provider: "exa",
          results: [],
        });
        expect(formatted).toBe(
          [
            SECURITY_NOTICE_PREFIX,
            'No web search results found for "non-existent-topic-xyz-123".',
          ].join("\n")
        );
      });
    });
  });

  // =========================================================================
  // 2. web_fetch Tool Execution and Output Formatting
  // =========================================================================
  describe("2. web_fetch Tool", () => {
    describe("Tool Definition & Metadata", () => {
      it("defines tool identity, schemas, prompt snippets, guidelines and renderers", () => {
        const registry = new ProviderRegistry();
        const tool = createWebFetchTool(registry);

        expect(tool.name).toBe(TOOL_IDS.fetch);
        expect(tool.label).toBe("web_fetch");
        expect(tool.parameters).toBe(webFetchSchema);
        expect(tool.description).toBe(WEB_FETCH_DESCRIPTION);
        expect(tool.promptSnippet).toBe(WEB_FETCH_PROMPT_SNIPPET);
        expect(tool.promptGuidelines).toEqual(WEB_FETCH_PROMPT_GUIDELINES);
        expect(typeof tool.renderCall).toBe("function");
        expect(typeof tool.renderResult).toBe("function");
      });

      it("validates the TypeBox parameter schema requirements", () => {
        expect(Object.keys(webFetchSchema.properties)).toEqual([
          "urls",
          "url",
          "maxCharacters",
        ]);
        expect(webFetchSchema.required).toBeUndefined();
        const urls = webFetchSchema.properties.urls as { anyOf: unknown[] };
        expect(urls.anyOf).toEqual([
          expect.objectContaining({
            type: "array",
            items: expect.objectContaining({ type: "string" }),
          }),
          expect.objectContaining({ type: "string" }),
        ]);
        expect(webFetchSchema.properties.url?.type).toBe("string");
        expect(webFetchSchema.properties.maxCharacters?.type).toBe("number");
      });
    });

    describe("Execution & Parameter Delegation", () => {
      it("executes fetch with default maxCharacters (5000)", async () => {
        const fetchMock = vi.fn(
          async (
            url: string | string[],
            _opts?: FetchOptions
          ): Promise<FetchResponse> =>
            sampleFetchResponse("exa")
        );
        const fetchProvider: FetchProvider = {
          id: "exa",
          name: "Exa Fetch",
          description: "Exa fetch provider",
          supportsApiKey: true,
          requiresApiKey: false,
          fetch: fetchMock,
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "exa",
          name: "Exa",
          description: "Exa provider module",
          capabilities: ["fetch"],
          fetchProvider,
        });

        const tool = createWebFetchTool(registry, {
          getConfig: async () => createMockConfig({ fetch: { enabled: true, provider: "exa" } }),
        });

        const controller = new AbortController();
        const result = await tool.execute(
          "call-fetch-1",
          { urls: "https://example.com/documentation" },
          controller.signal,
          undefined,
          undefined as unknown as ExtensionContext
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
          ["https://example.com/documentation"],
          { maxCharacters: WEB_FETCH_DEFAULT_MAX_CHARACTERS },
          controller.signal
        );

        expect(result.details).toEqual([sampleFetchResponse("exa")]);
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe("text");
        const formatted = extractTextContent(result);
        expect(formatted).toContain(SECURITY_NOTICE_PREFIX);
        expect(formatted).toContain(
          '<web_content url="https://example.com/documentation" title="Official Documentation" domain="example.com">'
        );
        expect(formatted).toContain("# Documentation\n\nComprehensive API overview and guides.");
      });

      it("batch-fetches multiple URLs in a single provider call", async () => {
        const fetchMock = vi.fn(
          async (
            url: string | string[],
            _opts?: FetchOptions
          ): Promise<FetchResponse[]> =>
            (Array.isArray(url) ? url : [url]).map((target) => ({
              url: target,
              content: `content of ${target}`,
              provider: "exa",
            }))
        );
        const fetchProvider: FetchProvider = {
          id: "exa",
          name: "Exa Fetch",
          description: "Exa fetch provider",
          supportsApiKey: true,
          requiresApiKey: false,
          fetch: fetchMock,
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "exa",
          name: "Exa",
          description: "Exa provider module",
          capabilities: ["fetch"],
          fetchProvider,
        });

        const tool = createWebFetchTool(registry, {
          getConfig: async () =>
            createMockConfig({ fetch: { enabled: true, provider: "exa" } }),
        });

        const result = await tool.execute(
          "call-fetch-batch",
          { urls: ["https://a.com/one", "https://b.com/two"] },
          undefined,
          undefined,
          undefined as unknown as ExtensionContext
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toEqual([
          "https://a.com/one",
          "https://b.com/two",
        ]);
        const details = result.details as FetchResponse[];
        expect(details).toHaveLength(2);
        expect(details.map((page) => page.url)).toEqual([
          "https://a.com/one",
          "https://b.com/two",
        ]);
        const formatted = extractTextContent(result);
        expect(formatted).toContain(SECURITY_NOTICE_PREFIX);
        expect(formatted).toContain(
          '<web_content url="https://a.com/one" title="" domain="a.com">'
        );
        expect(formatted).toContain(
          '<web_content url="https://b.com/two" title="" domain="b.com">'
        );
      });

      it("passes custom maxCharacters to provider", async () => {
        const fetchMock = vi.fn(
          async (url: string, _opts?: FetchOptions): Promise<FetchResponse> => ({
            url,
            content: "Short content",
            provider: "jina",
          })
        );
        const fetchProvider: FetchProvider = {
          id: "jina",
          name: "Jina Reader",
          description: "Jina reader provider",
          supportsApiKey: false,
          requiresApiKey: false,
          fetch: fetchMock,
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "jina",
          name: "Jina",
          description: "Jina module",
          capabilities: ["fetch"],
          fetchProvider,
        });

        const tool = createWebFetchTool(registry, {
          getConfig: async () => createMockConfig({ fetch: { enabled: true, provider: "jina" } }),
        });

        const params: WebFetchParams = {
          urls: "https://example.com/article",
          maxCharacters: 2000,
        };
        const result = await tool.execute(
          "call-fetch-2",
          params,
          undefined,
          undefined,
          undefined as unknown as ExtensionContext
        );

        expect(fetchMock).toHaveBeenCalledWith(
          ["https://example.com/article"],
          { maxCharacters: 2000 },
          undefined
        );
        expect(extractTextContent(result)).toContain(SECURITY_NOTICE_PREFIX);
        expect(extractTextContent(result)).toContain("Short content");
      });

      it("propagates AbortSignal to fetch provider", async () => {
        const controller = new AbortController();
        const fetchMock = vi.fn(
          async (_url: string, _opts?: FetchOptions, signal?: AbortSignal): Promise<FetchResponse> => {
            if (signal?.aborted) {
              throw new Error("Fetch cancelled");
            }
            return sampleFetchResponse("exa");
          }
        );
        const fetchProvider: FetchProvider = {
          id: "exa",
          name: "Exa",
          description: "Exa",
          supportsApiKey: true,
          requiresApiKey: false,
          fetch: fetchMock,
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "exa",
          name: "Exa",
          description: "Exa",
          capabilities: ["fetch"],
          fetchProvider,
        });

        const tool = createWebFetchTool(registry, {
          getConfig: async () => createMockConfig(),
        });

        controller.abort();
        await expect(
          tool.execute(
            "call-fetch-cancel",
            { urls: "https://example.com" },
            controller.signal,
            undefined,
            undefined as unknown as ExtensionContext
          )
        ).rejects.toThrow("Fetch cancelled");
      });

      it("propagates fetch provider runtime errors", async () => {
        const fetchProvider: FetchProvider = {
          id: "exa",
          name: "Exa",
          description: "Exa",
          supportsApiKey: true,
          requiresApiKey: false,
          fetch: vi.fn().mockRejectedValue(new Error("HTTP 404 Not Found")),
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "exa",
          name: "Exa",
          description: "Exa",
          capabilities: ["fetch"],
          fetchProvider,
        });

        const tool = createWebFetchTool(registry, {
          getConfig: async () => createMockConfig(),
        });

        await expect(
          tool.execute(
            "call-fetch-err",
            { urls: "https://example.com/404" },
            undefined,
            undefined,
            undefined as unknown as ExtensionContext
          )
        ).rejects.toThrow("HTTP 404 Not Found");
      });

      it("throws descriptive error when configured fetch provider is not found", async () => {
        const registry = new ProviderRegistry();
        const tool = createWebFetchTool(registry, {
          getConfig: async () => createMockConfig({ fetch: { enabled: true, provider: "unknown-fetch" } }),
        });

        await expect(
          tool.execute(
            "call-fetch-missing",
            { urls: "https://example.com" },
            undefined,
            undefined,
            undefined as unknown as ExtensionContext
          )
        ).rejects.toThrow(/Unknown provider "unknown-fetch" for capability "fetch"/);
      });
    });

    describe("Output Formatting (formatFetchResult)", () => {
      it("formats URL, title, provider and extracted markdown content", () => {
        const response: FetchResponse = {
          url: "https://github.com/features/actions",
          title: "GitHub Actions",
          content: "# GitHub Actions\n\nAutomate workflows easily.",
          provider: "exa",
        };

        const formatted = formatFetchResult(response);
        expect(formatted).toBe(
          [
            SECURITY_NOTICE_PREFIX,
            wrapWebContent({
              content: "# GitHub Actions\n\nAutomate workflows easily.",
              url: "https://github.com/features/actions",
              title: "GitHub Actions",
            }),
          ].join("\n")
        );
      });

      it("omits the title line cleanly when title is not provided", () => {
        const response: FetchResponse = {
          url: "https://raw.githubusercontent.com/file.txt",
          content: "Raw plain text content.",
          provider: "exa",
        };

        const formatted = formatFetchResult(response);
        expect(formatted).toBe(
          [
            SECURITY_NOTICE_PREFIX,
            wrapWebContent({
              content: "Raw plain text content.",
              url: "https://raw.githubusercontent.com/file.txt",
            }),
          ].join("\n")
        );
        expect(formatted).toContain('title=""');
      });

      it("returns clear message when content is empty", () => {
        const formatted = formatFetchResult({
          url: "https://example.com/empty",
          content: "",
          provider: "exa",
        });
        expect(formatted).toBe(
          [
            SECURITY_NOTICE_PREFIX,
            'No content could be extracted from "https://example.com/empty".',
          ].join("\n")
        );
      });
    });
  });

  // =========================================================================
  // 3. web_deep_search Tool Execution and Output Formatting
  // =========================================================================
  describe("3. web_deep_search Tool", () => {
    describe("Tool Definition & Metadata", () => {
      it("defines tool identity, schemas, prompt snippets, guidelines and renderers", () => {
        const registry = new ProviderRegistry();
        const tool = createWebDeepSearchTool(registry);

        expect(tool.name).toBe(TOOL_IDS.deepSearch);
        expect(tool.label).toBe("web_deep_search");
        expect(tool.parameters).toBe(webDeepSearchSchema);
        expect(tool.description).toBe(WEB_DEEP_SEARCH_DESCRIPTION);
        expect(tool.promptSnippet).toBe(WEB_DEEP_SEARCH_PROMPT_SNIPPET);
        expect(tool.promptGuidelines).toEqual(WEB_DEEP_SEARCH_PROMPT_GUIDELINES);
        expect(typeof tool.renderCall).toBe("function");
        expect(typeof tool.renderResult).toBe("function");
      });

      it("validates the TypeBox parameter schema requirements", () => {
        expect(Object.keys(webDeepSearchSchema.properties)).toEqual([
          "query",
          "numSources",
          "includeText",
          "numResults",
          "category",
          "additionalQueries",
        ]);
        expect(webDeepSearchSchema.required).toEqual(["query"]);
        expect(webDeepSearchSchema.properties.query.type).toBe("string");
        expect(webDeepSearchSchema.properties.numSources?.type).toBe("number");
        expect(webDeepSearchSchema.properties.includeText?.type).toBe("boolean");
        expect(webDeepSearchSchema.properties.numResults?.type).toBe("number");
        expect(webDeepSearchSchema.properties.category?.type).toBe("string");
        expect(webDeepSearchSchema.properties.additionalQueries?.type).toBe("array");
      });
    });

    describe("Execution & Parameter Delegation", () => {
      it("falls back to deepSearch with default numResults (10) when the provider has no answer", async () => {
        const deepSearchMock = vi.fn(
          async (query: string, _opts?: DeepSearchOptions): Promise<DeepSearchResponse> =>
            sampleDeepSearchResponse("exa")
        );
        const deepSearchProvider: DeepSearchProvider = {
          id: "exa",
          name: "Exa Deep Search",
          description: "Exa deep search provider",
          supportsApiKey: true,
          requiresApiKey: true,
          deepSearch: deepSearchMock,
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "exa",
          name: "Exa",
          description: "Exa provider module",
          capabilities: ["deep-search"],
          deepSearchProvider,
        });

        const tool = createWebDeepSearchTool(registry, {
          getConfig: async () =>
            createMockConfig({ deepSearch: { enabled: true, provider: "exa" } }),
        });

        const controller = new AbortController();
        const result = await tool.execute(
          "call-deep-1",
          { query: "Quantum error correction surface codes" },
          controller.signal,
          undefined,
          undefined as unknown as ExtensionContext
        );

        expect(deepSearchMock).toHaveBeenCalledTimes(1);
        expect(deepSearchMock).toHaveBeenCalledWith(
          "Quantum error correction surface codes",
          {
            numResults: WEB_DEEP_SEARCH_DEFAULT_NUM_RESULTS,
            category: undefined,
            additionalQueries: undefined,
          },
          controller.signal
        );

        expect(result.details).toEqual(sampleDeepSearchResponse("exa"));
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe("text");
        const formatted = extractTextContent(result);
        expect(formatted).toContain(
          'Deep search results for "Quantum error correction surface codes" (provider: exa, 3 results):'
        );
        expect(formatted).toContain(
          "Sub-queries executed: Quantum error correction surface codes, Surface code fault tolerance threshold, Lattice surgery quantum circuits"
        );
        expect(formatted).toContain("1. Surface Code Architectures");
        expect(formatted).toContain("URL: https://arxiv.org/abs/1208.0928");
        expect(formatted).toContain("Published: 2012-08-06 | Author: Austin G. Fowler et al.");
        expect(formatted).toContain("Highlights: 1% threshold under depolarizing noise; 2D nearest-neighbor coupling");
        expect(formatted).toContain("Surface codes offer high fault tolerance thresholds.");
        expect(formatted).toContain("2. Lattice Surgery in Planar Codes");
        expect(formatted).toContain("3. Quantum Computing Overview");
      });

      it("dispatches to provider.answer when available with numSources default 5 and includeText default true", async () => {
        const answerMock = vi.fn(
          async (
            query: string,
            _opts?: DeepSearchOptions
          ): Promise<DeepSearchResponse> => sampleDeepSearchResponse("exa")
        );
        const deepSearchMock = vi.fn<() => Promise<DeepSearchResponse>>();
        const deepSearchProvider: DeepSearchProvider = {
          id: "exa",
          name: "Exa",
          description: "Exa",
          supportsApiKey: true,
          requiresApiKey: true,
          deepSearch: deepSearchMock,
          answer: answerMock,
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "exa",
          name: "Exa",
          description: "Exa",
          capabilities: ["deep-search"],
          deepSearchProvider,
        });

        const tool = createWebDeepSearchTool(registry, {
          getConfig: async () =>
            createMockConfig({ deepSearch: { enabled: true, provider: "exa" } }),
        });

        const result = await tool.execute(
          "call-deep-answer",
          { query: "direct question" },
          undefined,
          undefined,
          undefined as unknown as ExtensionContext
        );

        expect(answerMock).toHaveBeenCalledTimes(1);
        expect(deepSearchMock).not.toHaveBeenCalled();
        expect(answerMock).toHaveBeenCalledWith(
          "direct question",
          {
            numSources: 5,
            includeText: true,
            numResults: undefined,
            category: undefined,
            additionalQueries: undefined,
          },
          undefined
        );
        expect(result.details).toEqual(sampleDeepSearchResponse("exa"));
        expect(extractTextContent(result)).toContain(SECURITY_NOTICE_PREFIX);
      });

      it("passes custom numResults, category and additionalQueries to provider", async () => {
        const deepSearchMock = vi.fn(
          async (query: string, _opts?: DeepSearchOptions): Promise<DeepSearchResponse> => ({
            query,
            provider: "exa",
            results: [],
          })
        );
        const deepSearchProvider: DeepSearchProvider = {
          id: "exa",
          name: "Exa",
          description: "Exa",
          supportsApiKey: true,
          requiresApiKey: true,
          deepSearch: deepSearchMock,
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "exa",
          name: "Exa",
          description: "Exa",
          capabilities: ["deep-search"],
          deepSearchProvider,
        });

        const tool = createWebDeepSearchTool(registry, {
          getConfig: async () => createMockConfig({ deepSearch: { enabled: true, provider: "exa" } }),
        });

        const params: WebDeepSearchParams = {
          query: "CRISPR gene editing advances",
          numResults: 15,
          category: "research_paper",
          additionalQueries: ["prime editing efficiency", "base editing in vivo"],
        };

        const result = await tool.execute(
          "call-deep-2",
          params,
          undefined,
          undefined,
          undefined as unknown as ExtensionContext
        );

        expect(deepSearchMock).toHaveBeenCalledWith(
          "CRISPR gene editing advances",
          {
            numResults: 15,
            category: "research_paper",
            additionalQueries: ["prime editing efficiency", "base editing in vivo"],
          },
          undefined
        );
        expect(extractTextContent(result)).toContain(SECURITY_NOTICE_PREFIX);
        expect(extractTextContent(result)).toContain(
          'No deep search results found for "CRISPR gene editing advances".'
        );
      });

      it("propagates AbortSignal to deep search provider", async () => {
        const controller = new AbortController();
        const deepSearchMock = vi.fn(
          async (_q: string, _opts?: DeepSearchOptions, signal?: AbortSignal): Promise<DeepSearchResponse> => {
            if (signal?.aborted) {
              throw new Error("Deep search cancelled");
            }
            return sampleDeepSearchResponse("exa");
          }
        );
        const deepSearchProvider: DeepSearchProvider = {
          id: "exa",
          name: "Exa",
          description: "Exa",
          supportsApiKey: true,
          requiresApiKey: true,
          deepSearch: deepSearchMock,
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "exa",
          name: "Exa",
          description: "Exa",
          capabilities: ["deep-search"],
          deepSearchProvider,
        });

        const tool = createWebDeepSearchTool(registry, {
          getConfig: async () => createMockConfig({ deepSearch: { enabled: true, provider: "exa" } }),
        });

        controller.abort();
        await expect(
          tool.execute(
            "call-deep-cancel",
            { query: "cancelled deep query" },
            controller.signal,
            undefined,
            undefined as unknown as ExtensionContext
          )
        ).rejects.toThrow("Deep search cancelled");
      });

      it("propagates deep search provider runtime errors", async () => {
        const deepSearchProvider: DeepSearchProvider = {
          id: "exa",
          name: "Exa",
          description: "Exa",
          supportsApiKey: true,
          requiresApiKey: true,
          deepSearch: vi.fn().mockRejectedValue(new Error("Deep search requires an Exa API key")),
        };
        const registry = new ProviderRegistry();
        registry.registerProvider({
          id: "exa",
          name: "Exa",
          description: "Exa",
          capabilities: ["deep-search"],
          deepSearchProvider,
        });

        const tool = createWebDeepSearchTool(registry, {
          getConfig: async () => createMockConfig({ deepSearch: { enabled: true, provider: "exa" } }),
        });

        await expect(
          tool.execute(
            "call-deep-err",
            { query: "test" },
            undefined,
            undefined,
            undefined as unknown as ExtensionContext
          )
        ).rejects.toThrow("Deep search requires an Exa API key");
      });

      it("throws descriptive error when configured deepSearch provider is not found", async () => {
        const registry = new ProviderRegistry();
        const tool = createWebDeepSearchTool(registry, {
          getConfig: async () =>
            createMockConfig({ deepSearch: { enabled: true, provider: "unregistered-deep" } }),
        });

        await expect(
          tool.execute(
            "call-deep-missing",
            { query: "test" },
            undefined,
            undefined,
            undefined as unknown as ExtensionContext
          )
        ).rejects.toThrow(/Unknown provider "unregistered-deep" for capability "deep-search"/);
      });
    });

    describe("Output Formatting (formatDeepSearchResults)", () => {
      it("formats sub-queries, numbering, URLs, metadata, highlights and text", () => {
        const response: DeepSearchResponse = {
          query: "fusion energy milestones",
          provider: "exa",
          subQueriesExecuted: ["fusion energy milestones", "ITER timeline 2025", "SPARC net energy gain"],
          results: [
            {
              title: "Fusion Progress",
              url: "https://example.com/fusion",
              author: "Energy Research",
              publishedDate: "2025-01-20",
              highlights: ["Q > 1 achieved in simulation", "High temperature superconductors deployed"],
              text: "Magnetic confinement fusion achieved new magnetic field records.",
            },
            {
              title: "Tokamak Design",
              url: "https://example.com/tokamak",
              text: "Compact tokamak designs allow faster iteration.",
            },
          ],
        };

        const formatted = formatDeepSearchResults(response);
        expect(formatted).toBe(
          [
            SECURITY_NOTICE_PREFIX,
            'Deep search results for "fusion energy milestones" (provider: exa, 2 results):',
            "Sub-queries executed: fusion energy milestones, ITER timeline 2025, SPARC net energy gain",
            "",
            "1. Fusion Progress",
            "   URL: https://example.com/fusion",
            "   Published: 2025-01-20 | Author: Energy Research",
            wrapWebContent({
              content:
                "Highlights: Q > 1 achieved in simulation; High temperature superconductors deployed\nMagnetic confinement fusion achieved new magnetic field records.",
              url: "https://example.com/fusion",
              title: "Fusion Progress",
            }),
            "2. Tokamak Design",
            "   URL: https://example.com/tokamak",
            wrapWebContent({
              content: "Compact tokamak designs allow faster iteration.",
              url: "https://example.com/tokamak",
              title: "Tokamak Design",
            }),
          ].join("\n")
        );
      });

      it("omits subQueriesExecuted line when empty or undefined", () => {
        const response: DeepSearchResponse = {
          query: "simple query",
          provider: "exa",
          results: [{ title: "Result", url: "https://example.com" }],
        };

        const formatted = formatDeepSearchResults(response);
        expect(formatted).not.toContain("Sub-queries executed:");
        expect(formatted).toBe(
          [
            SECURITY_NOTICE_PREFIX,
            'Deep search results for "simple query" (provider: exa, 1 results):',
            "",
            "1. Result",
            "   URL: https://example.com",
          ].join("\n")
        );
      });

      it("returns clear message when results list is empty", () => {
        const formatted = formatDeepSearchResults({
          query: "nothing found",
          provider: "exa",
          results: [],
        });
        expect(formatted).toBe(
          [
            SECURITY_NOTICE_PREFIX,
            'No deep search results found for "nothing found".',
          ].join("\n")
        );
      });
    });
  });

  // =========================================================================
  // 4. Multi-Provider & Default Config Integration
  // =========================================================================
  describe("4. Multi-Provider & Default Config Integration", () => {
    it("supports independent providers configured for each tool simultaneously", async () => {
      const searchMock = vi.fn().mockResolvedValue(sampleSearchResponse("search-only-provider"));
      const fetchMock = vi.fn().mockResolvedValue(sampleFetchResponse("fetch-only-provider"));
      const deepMock = vi.fn().mockResolvedValue(sampleDeepSearchResponse("deep-only-provider"));

      const searchMod: ProviderModule = {
        id: "search-only-provider",
        name: "Search Only",
        description: "Search only",
        capabilities: ["search"],
        searchProvider: {
          id: "search-only-provider",
          name: "Search Only",
          description: "Search only",
          supportsApiKey: false,
          requiresApiKey: false,
          search: searchMock,
        },
      };

      const fetchMod: ProviderModule = {
        id: "fetch-only-provider",
        name: "Fetch Only",
        description: "Fetch only",
        capabilities: ["fetch"],
        fetchProvider: {
          id: "fetch-only-provider",
          name: "Fetch Only",
          description: "Fetch only",
          supportsApiKey: false,
          requiresApiKey: false,
          fetch: fetchMock,
        },
      };

      const deepMod: ProviderModule = {
        id: "deep-only-provider",
        name: "Deep Only",
        description: "Deep only",
        capabilities: ["deep-search"],
        deepSearchProvider: {
          id: "deep-only-provider",
          name: "Deep Only",
          description: "Deep only",
          supportsApiKey: true,
          requiresApiKey: true,
          deepSearch: deepMock,
        },
      };

      const registry = new ProviderRegistry();
      registry.registerProvider(searchMod);
      registry.registerProvider(fetchMod);
      registry.registerProvider(deepMod);

      const customConfig: PiWebSearchAndFetchConfig = {
        search: { enabled: true, provider: "search-only-provider" },
        fetch: { enabled: true, provider: "fetch-only-provider" },
        deepSearch: { enabled: true, provider: "deep-only-provider" },
        providers: { exa: { useApiKey: true } },
      };

      const searchTool = createWebSearchTool(registry, { getConfig: async () => customConfig });
      const fetchTool = createWebFetchTool(registry, { getConfig: async () => customConfig });
      const deepTool = createWebDeepSearchTool(registry, { getConfig: async () => customConfig });

      const searchRes = await searchTool.execute(
        "s-1",
        { query: "test search" },
        undefined,
        undefined,
        undefined as unknown as ExtensionContext
      );
      const fetchRes = await fetchTool.execute(
        "f-1",
        { urls: "https://example.com" },
        undefined,
        undefined,
        undefined as unknown as ExtensionContext
      );
      const deepRes = await deepTool.execute(
        "d-1",
        { query: "test deep" },
        undefined,
        undefined,
        undefined as unknown as ExtensionContext
      );

      expect(searchRes.details.provider).toBe("search-only-provider");
      expect((fetchRes.details as FetchResponse[])[0].provider).toBe(
        "fetch-only-provider"
      );
      expect(deepRes.details.provider).toBe("deep-only-provider");
    });

    it("uses default getConfig reading from disk/defaults when getConfig option is omitted", async () => {
      const prevAgentDir = process.env.PI_AGENT_DIR;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-tools-test-"));
      process.env.PI_AGENT_DIR = tmpDir;

      try {
        const searchMock = vi.fn().mockResolvedValue(sampleSearchResponse("exa"));
        const fetchMock = vi.fn().mockResolvedValue(sampleFetchResponse("exa"));
        const deepMock = vi.fn().mockResolvedValue(sampleDeepSearchResponse("exa"));

        const exaModule: ProviderModule = {
          id: "exa",
          name: "Exa",
          description: "Exa triple provider",
          capabilities: ["search", "fetch", "deep-search"],
          searchProvider: {
            id: "exa",
            name: "Exa",
            description: "Exa",
            supportsApiKey: true,
            requiresApiKey: false,
            search: searchMock,
          },
          fetchProvider: {
            id: "exa",
            name: "Exa",
            description: "Exa",
            supportsApiKey: true,
            requiresApiKey: false,
            fetch: fetchMock,
          },
          deepSearchProvider: {
            id: "exa",
            name: "Exa",
            description: "Exa",
            supportsApiKey: true,
            requiresApiKey: true,
            deepSearch: deepMock,
          },
        };

        const registry = new ProviderRegistry();
        registry.registerProvider(exaModule);

        // Tools created without options default to disk/defaults getConfig
        const searchTool = createWebSearchTool(registry);
        const fetchTool = createWebFetchTool(registry);
        const deepTool = createWebDeepSearchTool(registry);

        const sRes = await searchTool.execute(
          "s-default",
          { query: "disk query" },
          undefined,
          undefined,
          undefined as unknown as ExtensionContext
        );
        const fRes = await fetchTool.execute(
          "f-default",
          { urls: "https://example.com/disk" },
          undefined,
          undefined,
          undefined as unknown as ExtensionContext
        );
        const dRes = await deepTool.execute(
          "d-default",
          { query: "disk deep" },
          undefined,
          undefined,
          undefined as unknown as ExtensionContext
        );

        expect(searchMock).toHaveBeenCalledWith(
          "disk query",
          { numResults: WEB_SEARCH_DEFAULT_NUM_RESULTS, category: undefined },
          undefined
        );
        expect(fetchMock).toHaveBeenCalledWith(
          ["https://example.com/disk"],
          { maxCharacters: WEB_FETCH_DEFAULT_MAX_CHARACTERS },
          undefined
        );
        expect(deepMock).toHaveBeenCalledWith(
          "disk deep",
          {
            numResults: WEB_DEEP_SEARCH_DEFAULT_NUM_RESULTS,
            category: undefined,
            additionalQueries: undefined,
          },
          undefined
        );

        expect(sRes.details.provider).toBe("exa");
        expect((fRes.details as FetchResponse[])[0].provider).toBe("exa");
        expect(dRes.details.provider).toBe("exa");
      } finally {
        if (prevAgentDir !== undefined) {
          process.env.PI_AGENT_DIR = prevAgentDir;
        } else {
          delete process.env.PI_AGENT_DIR;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
