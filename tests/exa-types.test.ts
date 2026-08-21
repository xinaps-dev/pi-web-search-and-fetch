import { describe, expect, it } from "vitest";
import type {
  ExaCategory,
  ExaDeepSearchOptions,
  ExaDeepSearchResponseRaw,
  ExaFetchOptions,
  ExaFetchResponseRaw,
  ExaSearchFilters,
  ExaSearchOptions,
  ExaSearchResponseRaw,
  ExaSearchResultRaw,
} from "../src/providers/exa/types.js";

describe("src/providers/exa/types", () => {
  it("accepts the documented Exa search categories", () => {
    const categories: ExaCategory[] = [
      "company",
      "research paper",
      "news",
      "github",
      "pdf",
      "tweet",
      "financial report",
    ];
    expect(categories).toHaveLength(7);
  });

  it("accepts an arbitrary category string (non-exhaustive)", () => {
    const category: ExaCategory = "arbitrary-category";
    expect(category).toBe("arbitrary-category");
  });

  it("defines ExaSearchOptions with numResults, category and filters", () => {
    const options: ExaSearchOptions = {
      numResults: 8,
      category: "news",
      filters: { startDate: "2024-01-01" },
    };
    expect(options.numResults).toBe(8);
    expect(options.category).toBe("news");
  });

  it("defines ExaSearchFilters with date bounds", () => {
    const filters: ExaSearchFilters = {
      startDate: "2024-01-01",
      endDate: "2024-12-31",
    };
    expect(filters.startDate).toBe("2024-01-01");
    expect(filters.endDate).toBe("2024-12-31");
  });

  it("defines ExaSearchResultRaw with required and optional fields", () => {
    const result: ExaSearchResultRaw = {
      title: "Example",
      url: "https://example.com",
      text: "snippet",
      publishedDate: "2024-01-01",
      author: "Author",
      score: 0.95,
      highlights: ["highlight"],
    };
    expect(result.title).toBe("Example");
    expect(result.url).toBe("https://example.com");
    expect(result.score).toBe(0.95);
  });

  it("defines ExaSearchResponseRaw wrapping raw results", () => {
    const response: ExaSearchResponseRaw = {
      results: [{ title: "Result 1", url: "https://example.com/1" }],
    };
    expect(response.results).toHaveLength(1);
  });

  it("defines ExaFetchOptions with maxCharacters and crawl options", () => {
    const options: ExaFetchOptions = {
      maxCharacters: 15000,
      maxDepth: 1,
      maxPages: 2,
    };
    expect(options.maxCharacters).toBe(15000);
    expect(options.maxDepth).toBe(1);
    expect(options.maxPages).toBe(2);
  });

  it("defines ExaFetchResponseRaw with clean markdown content", () => {
    const response: ExaFetchResponseRaw = {
      url: "https://example.com",
      title: "Example Page",
      content: "# Hello World",
      truncated: false,
    };
    expect(response.content).toBe("# Hello World");
    expect(response.truncated).toBe(false);
  });

  it("defines ExaDeepSearchOptions with additionalQueries", () => {
    const options: ExaDeepSearchOptions = {
      numResults: 10,
      category: "research paper",
      additionalQueries: ["query 1", "query 2"],
    };
    expect(options.numResults).toBe(10);
    expect(options.additionalQueries).toHaveLength(2);
  });

  it("defines ExaDeepSearchResponseRaw with results and executed sub-queries", () => {
    const response: ExaDeepSearchResponseRaw = {
      query: "complex research",
      results: [
        {
          title: "Finding 1",
          url: "https://example.com/1",
          highlights: ["highlight"],
        },
      ],
      subQueriesExecuted: ["query 1", "query 2"],
    };
    expect(response.query).toBe("complex research");
    expect(response.results).toHaveLength(1);
    expect(response.subQueriesExecuted).toHaveLength(2);
  });
});
