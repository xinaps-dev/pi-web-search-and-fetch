import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
import { ProviderRegistry } from "../src/providers/registry.js";
import type {
  ProviderModule,
  SearchOptions,
  SearchProvider,
  SearchResponse,
} from "../src/providers/types.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiWebSearchAndFetchConfig } from "../src/config/types.js";
import {
  SECURITY_NOTICE_PREFIX,
  wrapWebContent,
} from "../src/utils/security.js";

/**
 * Standard sample response used to verify the formatted output of
 * `web_search`.
 */
function sampleResponse(provider = "exa"): SearchResponse {
  return {
    query: "TypeScript 5.7 release notes",
    provider,
    results: [
      {
        title: "TypeScript 5.7",
        url: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/",
        snippet: "TypeScript 5.7 introduces No Property Access From Get Init.",
        publishedDate: "2024-11-15",
        author: "Microsoft",
      },
      {
        title: "TypeScript 5.7 on GitHub",
        url: "https://github.com/microsoft/TypeScript",
      },
    ],
  };
}

/** Full config shape with the `search` section pointing at `providerId`. */
function mockConfig(providerId = "exa"): PiWebSearchAndFetchConfig {
  return {
    search: { enabled: true, provider: providerId },
    fetch: { enabled: true, provider: providerId },
    deepSearch: { enabled: false, provider: providerId },
    providers: { exa: { useApiKey: true } },
  };
}

interface MockSearchProvider {
  provider: SearchProvider;
  /** The `search` implementation as a vitest mock (for call assertions). */
  searchMock: ReturnType<typeof vi.fn>;
  registry: ProviderRegistry;
  module: ProviderModule;
}

/**
 * Build a mock `SearchProvider` registered in a fresh `ProviderRegistry`
 * so `createWebSearchTool` can resolve it exactly like in production.
 */
function createMockSearchProvider(
  id = "exa",
  responseOrError?: SearchResponse | Error
): MockSearchProvider {
  const searchMock = vi.fn(
    async (
      query: string,
      options?: SearchOptions
    ): Promise<SearchResponse> => {
      if (responseOrError instanceof Error) {
        throw responseOrError;
      }
      const response = responseOrError ?? sampleResponse(id);
      return {
        ...response,
        query,
        metadata: {
          ...response.metadata,
          ...(options !== undefined && { options }),
        },
      };
    }
  );
  const provider: SearchProvider = {
    id,
    name: `Mock ${id}`,
    description: "mock search provider",
    supportsApiKey: false,
    requiresApiKey: false,
    search: searchMock,
  };
  const registry = new ProviderRegistry();
  const module: ProviderModule = {
    id,
    name: provider.name,
    description: provider.description,
    capabilities: ["search"],
    searchProvider: provider,
  };
  registry.registerProvider(module);
  return { provider, searchMock, registry, module };
}

/** Execute the tool with a fresh abort signal, mirroring the Pi runtime. */
async function executeTool(
  tool: ReturnType<typeof createWebSearchTool>,
  params: WebSearchParams
) {
  const controller = new AbortController();
  return tool.execute(
    "call-1",
    params,
    controller.signal,
    undefined,
    undefined as unknown as ExtensionContext
  );
}

/** Extract the text block from a tool result. */
function textOf(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const block = result.content[0];
  return block.text ?? "";
}

describe("src/tools/web-search", () => {
  describe("webSearchSchema", () => {
    it("declares the full parameter set", () => {
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
    });

    it("makes only query required", () => {
      expect(webSearchSchema.required).toEqual(["query"]);
    });

    it("types query as string, numResults as number and filters as strings/arrays", () => {
      expect(webSearchSchema.properties.query.type).toBe("string");
      expect(webSearchSchema.properties.numResults?.type).toBe("number");
      expect(webSearchSchema.properties.includeDomains?.type).toBe("array");
      expect(webSearchSchema.properties.includeDomains?.items).toEqual(
        expect.objectContaining({ type: "string" })
      );
      expect(webSearchSchema.properties.excludeDomains?.type).toBe("array");
      expect(webSearchSchema.properties.excludeDomains?.items).toEqual(
        expect.objectContaining({ type: "string" })
      );
      expect(webSearchSchema.properties.startPublishedDate?.type).toBe(
        "string"
      );
      expect(webSearchSchema.properties.endPublishedDate?.type).toBe("string");
      expect(webSearchSchema.properties.similarUrl?.type).toBe("string");
    });

    it("declares category as a union of the 7 Exa categories", () => {
      const category = webSearchSchema.properties.category as {
        anyOf: Array<{ type: string; const: string }>;
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
      expect(category.anyOf.every((entry) => entry.type === "string")).toBe(
        true
      );
    });
  });

  describe("prompt integration", () => {
    it("exposes the OpenCode-inspired snippet and guidelines", () => {
      expect(WEB_SEARCH_PROMPT_SNIPPET).toBe(
        "Search the web for current information, news, facts, people, companies, or documentation"
      );
      expect(WEB_SEARCH_PROMPT_GUIDELINES).toHaveLength(4);
      expect(WEB_SEARCH_PROMPT_GUIDELINES[0]).toContain(
        "Use web_search for discovering information"
      );
      expect(WEB_SEARCH_PROMPT_GUIDELINES[1]).toContain(
        "Always use the current year"
      );
      expect(WEB_SEARCH_PROMPT_GUIDELINES[2]).toContain(
        "includeDomains / excludeDomains"
      );
      expect(WEB_SEARCH_PROMPT_GUIDELINES[3]).toContain("web_fetch");
    });

    it("uses the fixed description mentioning the web_fetch follow-up", () => {
      expect(WEB_SEARCH_DESCRIPTION).toBe(
        "Search the web for current information, news, facts, people, companies, or documentation about any topic. Returns clean search results with titles, URLs, highlights, and publish dates. For extracting full page content, follow up with web_fetch."
      );
    });
  });

  describe("createWebSearchTool", () => {
    it("defines the web_search tool with schema, prompt fields and renderers", () => {
      const { registry } = createMockSearchProvider();
      const tool = createWebSearchTool(registry);

      expect(tool.name).toBe("web_search");
      expect(tool.label).toBe("web_search");
      expect(tool.parameters).toBe(webSearchSchema);
      expect(tool.description).toBe(WEB_SEARCH_DESCRIPTION);
      expect(tool.promptSnippet).toBe(WEB_SEARCH_PROMPT_SNIPPET);
      expect(tool.promptGuidelines).toEqual(WEB_SEARCH_PROMPT_GUIDELINES);
      expect(typeof tool.renderCall).toBe("function");
      expect(typeof tool.renderResult).toBe("function");
    });

    it("resolves the active provider from the config and returns formatted output", async () => {
      const { searchMock, registry } = createMockSearchProvider();
      const tool = createWebSearchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });

      const result = await executeTool(tool, { query: "TypeScript 5.7" });

      expect(searchMock).toHaveBeenCalledTimes(1);
      const [query, options] = searchMock.mock.calls[0];
      expect(query).toBe("TypeScript 5.7");
      expect(options).toEqual({
        numResults: WEB_SEARCH_DEFAULT_NUM_RESULTS,
        category: undefined,
        includeDomains: undefined,
        excludeDomains: undefined,
        startPublishedDate: undefined,
        endPublishedDate: undefined,
        similarUrl: undefined,
      });

      expect(result.details).toBeInstanceOf(Object);
      expect(result.details.query).toBe("TypeScript 5.7");
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const text = textOf(result);
      expect(text).toContain(SECURITY_NOTICE_PREFIX);
      expect(text).toContain(
        'Web search results for "TypeScript 5.7" (provider: exa, 2 results):'
      );
      expect(text).toContain(
        "1. TypeScript 5.7\n   URL: https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/"
      );
      expect(text).toContain("Published: 2024-11-15 | Author: Microsoft");
      expect(text).toContain(
        '<web_content url="https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/" title="TypeScript 5.7" domain="devblogs.microsoft.com">'
      );
      expect(text).toContain(
        "2. TypeScript 5.7 on GitHub\n   URL: https://github.com/microsoft/TypeScript"
      );
    });

    it("passes explicit numResults, category and advanced filters through to the provider", async () => {
      const { searchMock, registry } = createMockSearchProvider();
      const tool = createWebSearchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });

      await executeTool(tool, {
        query: "filtered news",
        numResults: 3,
        category: "research_paper",
        includeDomains: ["arxiv.org"],
        excludeDomains: ["reddit.com"],
        startPublishedDate: "2024-01-01",
        endPublishedDate: "2024-12-31",
        similarUrl: "https://example.com/reference",
      });

      expect(searchMock).toHaveBeenCalledWith(
        "filtered news",
        {
          numResults: 3,
          category: "research_paper",
          includeDomains: ["arxiv.org"],
          excludeDomains: ["reddit.com"],
          startPublishedDate: "2024-01-01",
          endPublishedDate: "2024-12-31",
          similarUrl: "https://example.com/reference",
        },
        expect.any(AbortSignal)
      );
    });

    it("forwards the caller abort signal to the provider", async () => {
      const { searchMock, registry } = createMockSearchProvider();
      const tool = createWebSearchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });
      const controller = new AbortController();

      await tool.execute(
        "call-2",
        { query: "cancel me" },
        controller.signal,
        undefined,
        undefined as unknown as ExtensionContext
      );

      expect(searchMock).toHaveBeenCalledWith(
        "cancel me",
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
    });

    it("defaults numResults to 10 when omitted", () => {
      expect(WEB_SEARCH_DEFAULT_NUM_RESULTS).toBe(10);
    });

    it("propagates provider errors", async () => {
      const boom = new Error("mock search failure");
      const { registry } = createMockSearchProvider("exa", boom);
      const tool = createWebSearchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });

      await expect(executeTool(tool, { query: "boom" })).rejects.toThrow(
        "mock search failure"
      );
    });

    it("throws a descriptive registry error for an unregistered provider", async () => {
      const { registry } = createMockSearchProvider();
      const tool = createWebSearchTool(registry, {
        getConfig: async () => mockConfig("missing"),
      });

      await expect(executeTool(tool, { query: "no provider" })).rejects.toThrow(
        /Unknown provider "missing" for capability "search"/
      );
    });

    it("uses the real getConfig by default when none is injected", async () => {
      // Point PI_AGENT_DIR at an empty temp dir so the real config reader
      // falls back to the built-in defaults (search.provider = "exa").
      const prevAgentDir = process.env.PI_AGENT_DIR;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-test-"));
      process.env.PI_AGENT_DIR = tmpDir;
      try {
        const { searchMock, registry } = createMockSearchProvider();
        const tool = createWebSearchTool(registry);

        const result = await executeTool(tool, { query: "defaults" });

        expect(searchMock).toHaveBeenCalledTimes(1);
        expect(result.details.provider).toBe("exa");
      } finally {
        if (prevAgentDir === undefined) {
          delete process.env.PI_AGENT_DIR;
        } else {
          process.env.PI_AGENT_DIR = prevAgentDir;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("formatSearchResults", () => {
    it("formats results with the security prefix and <web_content> wrapped snippets", () => {
      const text = formatSearchResults(sampleResponse());

      const expected = [
        SECURITY_NOTICE_PREFIX,
        'Web search results for "TypeScript 5.7 release notes" (provider: exa, 2 results):',
        "",
        "1. TypeScript 5.7",
        "   URL: https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/",
        "   Published: 2024-11-15 | Author: Microsoft",
        wrapWebContent({
          content: "TypeScript 5.7 introduces No Property Access From Get Init.",
          url: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/",
          title: "TypeScript 5.7",
        }),
        "2. TypeScript 5.7 on GitHub",
        "   URL: https://github.com/microsoft/TypeScript",
      ].join("\n");

      expect(text).toBe(expected);
    });

    it("wraps snippets in <web_content> blocks with url, title and domain attributes", () => {
      const text = formatSearchResults(sampleResponse());

      expect(text).toContain(SECURITY_NOTICE_PREFIX);
      expect(text).toMatch(
        /<web_content url="https:\/\/devblogs\.microsoft\.com\/typescript\/announcing-typescript-5-7\/" title="TypeScript 5\.7" domain="devblogs\.microsoft\.com">/
      );
      expect(text).toContain("</web_content>");
    });

    it("omits metadata and snippet lines when absent", () => {
      const text = formatSearchResults({
        query: "q",
        provider: "exa",
        results: [{ title: "Only title", url: "https://a.b" }],
      });

      expect(text).toBe(
        [
          SECURITY_NOTICE_PREFIX,
          'Web search results for "q" (provider: exa, 1 results):',
          "",
          "1. Only title",
          "   URL: https://a.b",
        ].join("\n")
      );
    });

    it("reports when no results were found", () => {
      expect(
        formatSearchResults({ query: "nothing", provider: "exa", results: [] })
      ).toBe(
        [
          SECURITY_NOTICE_PREFIX,
          'No web search results found for "nothing".',
        ].join("\n")
      );
    });
  });
});
