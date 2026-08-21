import { describe, expect, it } from "vitest";
import type {
  DeepSearchOptions,
  DeepSearchProvider,
  DeepSearchResponse,
  FetchOptions,
  FetchProvider,
  FetchResponse,
  ProviderCapability,
  ProviderModule,
  SearchOptions,
  SearchProvider,
  SearchResponse,
  SearchResultItem,
} from "../src/providers/types.js";

describe("src/providers/types", () => {
  it("defines the three provider capabilities", () => {
    const caps: ProviderCapability[] = ["search", "fetch", "deep-search"];
    expect(caps).toHaveLength(3);
  });

  it("defines a SearchResultItem with required and optional fields", () => {
    const item: SearchResultItem = {
      title: "Example",
      url: "https://example.com",
      snippet: "A snippet",
      publishedDate: "2024-01-01",
      author: "Author",
      score: 0.95,
    };
    expect(item.title).toBe("Example");
    expect(item.url).toBe("https://example.com");
    expect(item.score).toBe(0.95);
  });

  it("defines a SearchResponse with query, results, and provider", () => {
    const response: SearchResponse = {
      query: "test query",
      results: [
        { title: "Result 1", url: "https://example.com/1" },
        { title: "Result 2", url: "https://example.com/2" },
      ],
      provider: "exa",
    };
    expect(response.query).toBe("test query");
    expect(response.results).toHaveLength(2);
    expect(response.provider).toBe("exa");
  });

  it("defines a FetchResponse with url, content, and provider", () => {
    const response: FetchResponse = {
      url: "https://example.com",
      title: "Example Page",
      content: "# Hello World",
      provider: "exa",
    };
    expect(response.url).toBe("https://example.com");
    expect(response.content).toBe("# Hello World");
    expect(response.provider).toBe("exa");
  });

  it("defines a DeepSearchResponse with results and optional subQueries", () => {
    const response: DeepSearchResponse = {
      query: "complex research",
      results: [
        {
          title: "Finding 1",
          url: "https://example.com/1",
          text: "Some text",
          highlights: ["highlight"],
        },
      ],
      subQueriesExecuted: ["sub query 1", "sub query 2"],
      provider: "exa",
    };
    expect(response.query).toBe("complex research");
    expect(response.results).toHaveLength(1);
    expect(response.subQueriesExecuted).toHaveLength(2);
    expect(response.provider).toBe("exa");
  });

  it("defines SearchOptions with numResults and category", () => {
    const options: SearchOptions = {
      numResults: 5,
      category: "news",
    };
    expect(options.numResults).toBe(5);
    expect(options.category).toBe("news");
  });

  it("defines extended SearchOptions with domain and date filters", () => {
    const options: SearchOptions = {
      numResults: 10,
      category: "news",
      includeDomains: ["example.com", "docs.example.org"],
      excludeDomains: ["spam.example.net"],
      startPublishedDate: "2024-01-01",
      endPublishedDate: "2024-12-31",
      similarUrl: "https://example.com/reference",
    };
    expect(options.includeDomains).toEqual(["example.com", "docs.example.org"]);
    expect(options.excludeDomains).toEqual(["spam.example.net"]);
    expect(options.startPublishedDate).toBe("2024-01-01");
    expect(options.endPublishedDate).toBe("2024-12-31");
    expect(options.similarUrl).toBe("https://example.com/reference");
  });

  it("defines FetchOptions with maxCharacters", () => {
    const options: FetchOptions = {
      maxCharacters: 10000,
    };
    expect(options.maxCharacters).toBe(10000);
  });

  it("defines DeepSearchOptions with additionalQueries", () => {
    const options: DeepSearchOptions = {
      numResults: 10,
      category: "research paper",
      additionalQueries: ["query 1", "query 2"],
    };
    expect(options.numResults).toBe(10);
    expect(options.additionalQueries).toHaveLength(2);
  });

  it("defines extended DeepSearchOptions with numSources and includeText", () => {
    const options: DeepSearchOptions = {
      numResults: 10,
      numSources: 5,
      includeText: true,
      additionalQueries: ["query 1"],
    };
    expect(options.numResults).toBe(10);
    expect(options.numSources).toBe(5);
    expect(options.includeText).toBe(true);
    expect(options.additionalQueries).toHaveLength(1);
  });

  it("defines a SearchProvider contract with required fields", async () => {
    const mockProvider: SearchProvider = {
      id: "mock",
      name: "Mock Provider",
      description: "A mock search provider",
      supportsApiKey: true,
      requiresApiKey: false,
      search: async (query: string, options?: SearchOptions, signal?: AbortSignal) => ({
        query,
        results: [],
        provider: "mock",
      }),
    };
    expect(mockProvider.id).toBe("mock");
    expect(mockProvider.supportsApiKey).toBe(true);
    expect(mockProvider.requiresApiKey).toBe(false);

    const result = await mockProvider.search("test");
    expect(result.query).toBe("test");
    expect(result.provider).toBe("mock");
  });

  it("supports the optional SearchProvider.findSimilar method", async () => {
    const mockProvider: SearchProvider = {
      id: "mock",
      name: "Mock Provider",
      description: "A mock search provider",
      supportsApiKey: true,
      requiresApiKey: false,
      search: async (query: string) => ({ query, results: [], provider: "mock" }),
      findSimilar: async (url: string) => ({
        query: url,
        results: [{ title: "Similar", url: "https://example.com/similar" }],
        provider: "mock",
      }),
    };

    expect(typeof mockProvider.findSimilar).toBe("function");

    const result = await mockProvider.findSimilar!("https://example.com/original");
    expect(result.query).toBe("https://example.com/original");
    expect(result.provider).toBe("mock");
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe("https://example.com/similar");
  });

  it("defines a FetchProvider contract with required fields", async () => {
    const mockProvider: FetchProvider = {
      id: "mock",
      name: "Mock Provider",
      description: "A mock fetch provider",
      supportsApiKey: false,
      requiresApiKey: false,
      fetch: async (url: string, options?: FetchOptions, signal?: AbortSignal) => ({
        url,
        content: "mock content",
        provider: "mock",
      }),
    };
    expect(mockProvider.id).toBe("mock");
    expect(mockProvider.supportsApiKey).toBe(false);

    const result = (await mockProvider.fetch(
      "https://example.com"
    )) as FetchResponse;
    expect(result.url).toBe("https://example.com");
    expect(result.content).toBe("mock content");
  });

  it("supports FetchProvider.fetch with a single URL and a batch of URLs", async () => {
    const mockProvider: FetchProvider = {
      id: "mock",
      name: "Mock Provider",
      description: "A mock fetch provider",
      supportsApiKey: false,
      requiresApiKey: false,
      fetch: async (url: string | string[]) => {
        if (Array.isArray(url)) {
          return url.map((u) => ({
            url: u,
            content: `content of ${u}`,
            provider: "mock",
          }));
        }
        return { url, content: `content of ${url}`, provider: "mock" };
      },
    };

    const single = await mockProvider.fetch("https://example.com/1");
    expect(Array.isArray(single)).toBe(false);
    expect((single as FetchResponse).url).toBe("https://example.com/1");
    expect((single as FetchResponse).content).toBe(
      "content of https://example.com/1"
    );

    const batch = await mockProvider.fetch([
      "https://example.com/1",
      "https://example.com/2",
    ]);
    expect(Array.isArray(batch)).toBe(true);
    const batchResponse = batch as FetchResponse[];
    expect(batchResponse).toHaveLength(2);
    expect(batchResponse.map((r) => r.url)).toEqual([
      "https://example.com/1",
      "https://example.com/2",
    ]);
  });

  it("defines a DeepSearchProvider contract with required fields", async () => {
    const mockProvider: DeepSearchProvider = {
      id: "mock",
      name: "Mock Provider",
      description: "A mock deep search provider",
      supportsApiKey: true,
      requiresApiKey: true,
      deepSearch: async (
        query: string,
        options?: DeepSearchOptions,
        signal?: AbortSignal
      ) => ({
        query,
        results: [],
        provider: "mock",
      }),
    };
    expect(mockProvider.id).toBe("mock");
    expect(mockProvider.supportsApiKey).toBe(true);
    expect(mockProvider.requiresApiKey).toBe(true);

    const result = await mockProvider.deepSearch("deep query");
    expect(result.query).toBe("deep query");
    expect(result.provider).toBe("mock");
  });

  it("supports the optional DeepSearchProvider.answer method", async () => {
    const mockProvider: DeepSearchProvider = {
      id: "mock",
      name: "Mock Provider",
      description: "A mock deep search provider",
      supportsApiKey: true,
      requiresApiKey: true,
      deepSearch: async (query: string) => ({
        query,
        results: [],
        provider: "mock",
      }),
      answer: async (query: string) => ({
        query,
        results: [
          {
            title: "Answer",
            url: "https://example.com/answer",
            text: "synthesized answer",
          },
        ],
        provider: "mock",
      }),
    };

    expect(typeof mockProvider.answer).toBe("function");

    const result = await mockProvider.answer!("what is pi?");
    expect(result.query).toBe("what is pi?");
    expect(result.provider).toBe("mock");
    expect(result.results).toHaveLength(1);
    expect(result.results[0].text).toBe("synthesized answer");
  });

  it("defines a ProviderModule grouping capabilities and providers", () => {
    const module: ProviderModule = {
      id: "exa",
      name: "Exa",
      description: "Exa provider with triple capability",
      capabilities: ["search", "fetch", "deep-search"],
      searchProvider: {
        id: "exa",
        name: "Exa",
        description: "Exa search",
        supportsApiKey: true,
        requiresApiKey: false,
        search: async () => ({ query: "", results: [], provider: "exa" }),
      },
      fetchProvider: {
        id: "exa",
        name: "Exa",
        description: "Exa fetch",
        supportsApiKey: true,
        requiresApiKey: false,
        fetch: async () => ({ url: "", content: "", provider: "exa" }),
      },
      deepSearchProvider: {
        id: "exa",
        name: "Exa",
        description: "Exa deep search",
        supportsApiKey: true,
        requiresApiKey: true,
        deepSearch: async () => ({ query: "", results: [], provider: "exa" }),
      },
    };

    expect(module.id).toBe("exa");
    expect(module.capabilities).toHaveLength(3);
    expect(module.searchProvider).toBeDefined();
    expect(module.fetchProvider).toBeDefined();
    expect(module.deepSearchProvider).toBeDefined();
  });

  it("defines a ProviderModule with only search capability", () => {
    const module: ProviderModule = {
      id: "brave",
      name: "Brave",
      description: "Brave search only",
      capabilities: ["search"],
      searchProvider: {
        id: "brave",
        name: "Brave",
        description: "Brave search",
        supportsApiKey: true,
        requiresApiKey: true,
        search: async () => ({ query: "", results: [], provider: "brave" }),
      },
    };

    expect(module.capabilities).toEqual(["search"]);
    expect(module.fetchProvider).toBeUndefined();
    expect(module.deepSearchProvider).toBeUndefined();
  });
});
