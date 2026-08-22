import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WEB_DEEP_SEARCH_DEFAULT_NUM_RESULTS,
  WEB_DEEP_SEARCH_DEFAULT_NUM_SOURCES,
  WEB_DEEP_SEARCH_DESCRIPTION,
  WEB_DEEP_SEARCH_PROMPT_GUIDELINES,
  WEB_DEEP_SEARCH_PROMPT_SNIPPET,
  createWebDeepSearchTool,
  formatDeepSearchResults,
  webDeepSearchSchema,
  type WebDeepSearchParams,
} from "../src/tools/web-deep-search.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type {
  DeepSearchOptions,
  DeepSearchProvider,
  DeepSearchResponse,
  ProviderModule,
} from "../src/providers/types.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiWebSearchAndFetchConfig } from "../src/config/types.js";
import {
  SECURITY_NOTICE_PREFIX,
  wrapWebContent,
} from "../src/utils/security.js";

/**
 * Standard sample response used to verify the formatted output of
 * `web_deep_search`.
 */
function sampleResponse(provider = "exa"): DeepSearchResponse {
  return {
    query: "TypeScript 5.7 adoption in the ecosystem",
    provider,
    subQueriesExecuted: [
      "TypeScript 5.7 adoption in the ecosystem",
      "TypeScript 5.7 breaking changes",
    ],
    results: [
      {
        title: "TypeScript 5.7",
        url: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/",
        text: "TypeScript 5.7 introduces No Property Access From Get Init.",
        highlights: ["No Property Access From Get Init"],
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

/** Full config shape with the `deepSearch` section pointing at `providerId`. */
function mockConfig(providerId = "exa"): PiWebSearchAndFetchConfig {
  return {
    search: { enabled: true, provider: providerId },
    fetch: { enabled: true, provider: providerId },
    deepSearch: { enabled: true, provider: providerId },
    providers: { exa: { useApiKey: true } },
  };
}

interface MockDeepSearchProvider {
  provider: DeepSearchProvider;
  /** The `deepSearch` implementation as a vitest mock (for call assertions). */
  deepSearchMock: ReturnType<typeof vi.fn>;
  registry: ProviderRegistry;
  module: ProviderModule;
}

/**
 * Build a mock `DeepSearchProvider` registered in a fresh `ProviderRegistry`
 * so `createWebDeepSearchTool` can resolve it exactly like in production.
 *
 * `withAnswer` adds an `answer` implementation so the transparent
 * `answer` dispatch can be exercised.
 */
function createMockDeepSearchProvider(
  id = "exa",
  responseOrError?: DeepSearchResponse | Error,
  withAnswer = false
): MockDeepSearchProvider {
  const deepSearchMock = vi.fn(
    async (
      query: string,
      options?: DeepSearchOptions
    ): Promise<DeepSearchResponse> => {
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
  const answerMock = vi.fn(
    async (
      query: string,
      options?: DeepSearchOptions
    ): Promise<DeepSearchResponse> => {
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
  const provider: DeepSearchProvider = {
    id,
    name: `Mock ${id}`,
    description: "mock deep-search provider",
    supportsApiKey: false,
    requiresApiKey: false,
    deepSearch: deepSearchMock,
    ...(withAnswer && { answer: answerMock }),
  };
  const registry = new ProviderRegistry();
  const module: ProviderModule = {
    id,
    name: provider.name,
    description: provider.description,
    capabilities: ["deep-search"],
    deepSearchProvider: provider,
  };
  registry.registerProvider(module);
  return { provider, deepSearchMock, registry, module };
}

/** Execute the tool with a fresh abort signal, mirroring the Pi runtime. */
async function executeTool(
  tool: ReturnType<typeof createWebDeepSearchTool>,
  params: WebDeepSearchParams
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

describe("src/tools/web-deep-search", () => {
  describe("webDeepSearchSchema", () => {
    it("declares query, numSources, includeText, numResults, category and additionalQueries", () => {
      expect(Object.keys(webDeepSearchSchema.properties)).toEqual([
        "query",
        "numSources",
        "includeText",
        "numResults",
        "category",
        "additionalQueries",
      ]);
    });

    it("makes only query required", () => {
      expect(webDeepSearchSchema.required).toEqual(["query"]);
    });

    it("types the parameters as string, number, boolean, number, string and array of strings", () => {
      expect(webDeepSearchSchema.properties.query.type).toBe("string");
      expect(webDeepSearchSchema.properties.numSources?.type).toBe("number");
      expect(webDeepSearchSchema.properties.includeText?.type).toBe("boolean");
      expect(webDeepSearchSchema.properties.numResults?.type).toBe("number");
      expect(webDeepSearchSchema.properties.category?.type).toBe("string");
      expect(webDeepSearchSchema.properties.additionalQueries?.type).toBe(
        "array"
      );
      expect(webDeepSearchSchema.properties.additionalQueries?.items).toEqual(
        expect.objectContaining({ type: "string" })
      );
    });
  });

  describe("prompt integration", () => {
    it("exposes the snippet and guidelines", () => {
      expect(WEB_DEEP_SEARCH_PROMPT_SNIPPET).toBe(
        "In-depth web investigation with direct, source-grounded answers and citations"
      );
      expect(WEB_DEEP_SEARCH_PROMPT_GUIDELINES).toHaveLength(1);
      expect(WEB_DEEP_SEARCH_PROMPT_GUIDELINES[0]).toContain(
        "Use web_deep_search for complex questions"
      );
      expect(WEB_DEEP_SEARCH_PROMPT_GUIDELINES[0]).toContain(
        "multi-source synthesis"
      );
    });

    it("describes deep research and synthesized answers", () => {
      expect(WEB_DEEP_SEARCH_DESCRIPTION).toContain(
        "in-depth web investigation"
      );
      expect(WEB_DEEP_SEARCH_DESCRIPTION).toContain(
        "synthesized answers grounded in authoritative sources"
      );
      expect(WEB_DEEP_SEARCH_DESCRIPTION).toContain("citations");
    });
  });

  describe("createWebDeepSearchTool", () => {
    it("defines the web_deep_search tool with schema, prompt fields and renderers", () => {
      const { registry } = createMockDeepSearchProvider();
      const tool = createWebDeepSearchTool(registry);

      expect(tool.name).toBe("web_deep_search");
      expect(tool.label).toBe("web_deep_search");
      expect(tool.parameters).toBe(webDeepSearchSchema);
      expect(tool.description).toBe(WEB_DEEP_SEARCH_DESCRIPTION);
      expect(tool.promptSnippet).toBe(WEB_DEEP_SEARCH_PROMPT_SNIPPET);
      expect(tool.promptGuidelines).toEqual(WEB_DEEP_SEARCH_PROMPT_GUIDELINES);
      expect(typeof tool.renderCall).toBe("function");
      expect(typeof tool.renderResult).toBe("function");
    });

    it("falls back to deepSearch when the provider has no answer and returns formatted output", async () => {
      const { deepSearchMock, registry } = createMockDeepSearchProvider();
      const tool = createWebDeepSearchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });

      const result = await executeTool(tool, {
        query: "TypeScript 5.7 adoption",
      });

      expect(deepSearchMock).toHaveBeenCalledTimes(1);
      const [query, options] = deepSearchMock.mock.calls[0];
      expect(query).toBe("TypeScript 5.7 adoption");
      expect(options).toEqual({
        numResults: WEB_DEEP_SEARCH_DEFAULT_NUM_RESULTS,
        category: undefined,
        additionalQueries: undefined,
      });

      expect(result.details).toBeInstanceOf(Object);
      expect(result.details.query).toBe("TypeScript 5.7 adoption");
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const text = textOf(result);
      expect(text).toContain(SECURITY_NOTICE_PREFIX);
      expect(text).toContain(
        'Deep search results for "TypeScript 5.7 adoption" (provider: exa, 2 results):'
      );
      expect(text).toContain(
        "Sub-queries executed: TypeScript 5.7 adoption in the ecosystem, TypeScript 5.7 breaking changes"
      );
      expect(text).toContain(
        "1. TypeScript 5.7\n   URL: https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/"
      );
      expect(text).toContain("Published: 2024-11-15 | Author: Microsoft");
      expect(text).toContain(
        '<web_content url="https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/" title="TypeScript 5.7" domain="devblogs.microsoft.com">'
      );
      expect(text).toContain("Highlights: No Property Access From Get Init");
      expect(text).toContain(
        "TypeScript 5.7 introduces No Property Access From Get Init."
      );
      expect(text).toContain(
        "2. TypeScript 5.7 on GitHub\n   URL: https://github.com/microsoft/TypeScript"
      );
    });

    it("dispatches to provider.answer when available with numSources default 5 and includeText default true", async () => {
      const { provider, registry } = createMockDeepSearchProvider(
        "exa",
        undefined,
        true
      );
      const answerMock = provider.answer as ReturnType<typeof vi.fn>;
      const tool = createWebDeepSearchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });

      const result = await executeTool(tool, {
        query: "answer me",
      });

      expect(answerMock).toHaveBeenCalledTimes(1);
      expect(answerMock).toHaveBeenCalledWith(
        "answer me",
        {
          numSources: WEB_DEEP_SEARCH_DEFAULT_NUM_SOURCES,
          includeText: true,
          numResults: undefined,
          category: undefined,
          additionalQueries: undefined,
        },
        expect.any(AbortSignal)
      );
      expect(result.details.query).toBe("answer me");
    });

    it("passes explicit numSources, includeText, numResults, category and additionalQueries to answer", async () => {
      const { provider, registry } = createMockDeepSearchProvider(
        "exa",
        undefined,
        true
      );
      const answerMock = provider.answer as ReturnType<typeof vi.fn>;
      const tool = createWebDeepSearchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });

      await executeTool(tool, {
        query: "main query",
        numSources: 3,
        includeText: false,
        numResults: 8,
        category: "research_paper",
        additionalQueries: ["sub query one", "sub query two"],
      });

      expect(answerMock).toHaveBeenCalledWith(
        "main query",
        {
          numSources: 3,
          includeText: false,
          numResults: 8,
          category: "research_paper",
          additionalQueries: ["sub query one", "sub query two"],
        },
        expect.any(AbortSignal)
      );
    });

    it("forwards the caller abort signal to the provider", async () => {
      const { deepSearchMock, registry } = createMockDeepSearchProvider();
      const tool = createWebDeepSearchTool(registry, {
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

      expect(deepSearchMock).toHaveBeenCalledWith(
        "cancel me",
        {
          numResults: WEB_DEEP_SEARCH_DEFAULT_NUM_RESULTS,
          category: undefined,
          additionalQueries: undefined,
        },
        controller.signal
      );
    });

    it("defaults numSources to 5 and numResults to 10", () => {
      expect(WEB_DEEP_SEARCH_DEFAULT_NUM_SOURCES).toBe(5);
      expect(WEB_DEEP_SEARCH_DEFAULT_NUM_RESULTS).toBe(10);
    });

    it("propagates provider errors", async () => {
      const boom = new Error("mock deep search failure");
      const { registry } = createMockDeepSearchProvider("exa", boom);
      const tool = createWebDeepSearchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });

      await expect(executeTool(tool, { query: "boom" })).rejects.toThrow(
        "mock deep search failure"
      );
    });

    it("throws a descriptive registry error for an unregistered provider", async () => {
      const { registry } = createMockDeepSearchProvider();
      const tool = createWebDeepSearchTool(registry, {
        getConfig: async () => mockConfig("missing"),
      });

      await expect(executeTool(tool, { query: "no provider" })).rejects.toThrow(
        /Unknown provider "missing" for capability "deep-search"/
      );
    });

    it("uses the real getConfig by default when none is injected", async () => {
      // Point PI_AGENT_DIR at an empty temp dir so the real config reader
      // falls back to the built-in defaults (deepSearch.provider = "exa").
      const prevAgentDir = process.env.PI_AGENT_DIR;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-test-"));
      process.env.PI_AGENT_DIR = tmpDir;
      try {
        const { deepSearchMock, registry } = createMockDeepSearchProvider();
        const tool = createWebDeepSearchTool(registry);

        const result = await executeTool(tool, { query: "defaults" });

        expect(deepSearchMock).toHaveBeenCalledTimes(1);
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

  describe("formatDeepSearchResults", () => {
    it("formats the security prefix, sub-queries, answer and <web_content> wrapped sources", () => {
      const response: DeepSearchResponse = {
        ...sampleResponse(),
        metadata: {
          answer: "TypeScript 5.7 adoption is widespread across the ecosystem.",
        },
      };

      const text = formatDeepSearchResults(response);

      const expected = [
        SECURITY_NOTICE_PREFIX,
        'Deep search results for "TypeScript 5.7 adoption in the ecosystem" (provider: exa, 2 results):',
        "Sub-queries executed: TypeScript 5.7 adoption in the ecosystem, TypeScript 5.7 breaking changes",
        "",
        wrapWebContent({
          content: "TypeScript 5.7 adoption is widespread across the ecosystem.",
          title: "Synthesized Answer",
        }),
        "",
        "1. TypeScript 5.7",
        "   URL: https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/",
        "   Published: 2024-11-15 | Author: Microsoft",
        wrapWebContent({
          content:
            "Highlights: No Property Access From Get Init\nTypeScript 5.7 introduces No Property Access From Get Init.",
          url: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/",
          title: "TypeScript 5.7",
        }),
        "2. TypeScript 5.7 on GitHub",
        "   URL: https://github.com/microsoft/TypeScript",
      ].join("\n");

      expect(text).toBe(expected);
    });

    it("wraps the synthesized answer in a <web_content> block titled Synthesized Answer", () => {
      const response: DeepSearchResponse = {
        ...sampleResponse(),
        metadata: { answer: "Direct answer text." },
      };

      const text = formatDeepSearchResults(response);

      expect(text).toContain(SECURITY_NOTICE_PREFIX);
      expect(text).toContain(
        '<web_content url="" title="Synthesized Answer" domain="">'
      );
      expect(text).toContain("Direct answer text.");
      expect(text).toContain("</web_content>");
    });

    it("omits optional lines and the sub-queries line when absent", () => {
      const text = formatDeepSearchResults({
        query: "q",
        provider: "exa",
        results: [{ title: "Only title", url: "https://a.b" }],
      });

      expect(text).toBe(
        [
          SECURITY_NOTICE_PREFIX,
          'Deep search results for "q" (provider: exa, 1 results):',
          "",
          "1. Only title",
          "   URL: https://a.b",
        ].join("\n")
      );
    });

    it("reports when no results were found", () => {
      expect(
        formatDeepSearchResults({
          query: "nothing",
          provider: "exa",
          results: [],
        })
      ).toBe(
        [
          SECURITY_NOTICE_PREFIX,
          'No deep search results found for "nothing".',
        ].join("\n")
      );
    });
  });
});
