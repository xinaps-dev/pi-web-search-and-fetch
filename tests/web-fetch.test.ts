import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
import { ProviderRegistry } from "../src/providers/registry.js";
import type {
  FetchOptions,
  FetchProvider,
  FetchResponse,
  ProviderModule,
} from "../src/providers/types.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiWebScoutConfig } from "../src/config/types.js";
import {
  SECURITY_NOTICE_PREFIX,
  wrapWebContent,
} from "../src/utils/security.js";

/**
 * Standard sample response used to verify the formatted output of
 * `web_fetch`.
 */
function sampleResponse(provider = "exa"): FetchResponse {
  return {
    url: "https://example.com/article",
    title: "Example Article",
    content: "# Article\n\nFull markdown content.",
    provider,
  };
}

/** Full config shape with the `fetch` section pointing at `providerId`. */
function mockConfig(providerId = "exa"): PiWebScoutConfig {
  return {
    search: { enabled: true, provider: providerId },
    fetch: { enabled: true, provider: providerId },
    deepSearch: { enabled: false, provider: providerId },
    providers: { exa: { useApiKey: true } },
  };
}

interface MockFetchProvider {
  provider: FetchProvider;
  /** The `fetch` implementation as a vitest mock (for call assertions). */
  fetchMock: ReturnType<typeof vi.fn>;
  registry: ProviderRegistry;
  module: ProviderModule;
}

/**
 * Build a mock `FetchProvider` registered in a fresh `ProviderRegistry`
 * so `createWebFetchTool` can resolve it exactly like in production.
 *
 * The mock echoes one `FetchResponse` per requested URL (the tool always
 * passes a normalized URL array), unless a fixed response/error was
 * injected.
 */
function createMockFetchProvider(
  id = "exa",
  responseOrError?: FetchResponse | FetchResponse[] | Error
): MockFetchProvider {
  const fetchMock = vi.fn(
    async (
      url: string | string[],
      options?: FetchOptions
    ): Promise<FetchResponse | FetchResponse[]> => {
      if (responseOrError instanceof Error) {
        throw responseOrError;
      }
      if (Array.isArray(responseOrError)) {
        return responseOrError;
      }
      const targets = Array.isArray(url) ? url : [url];
      const base = responseOrError ?? sampleResponse(id);
      const responses = targets.map((target) => ({
        ...base,
        url: target,
        metadata: {
          ...base.metadata,
          ...(options !== undefined && { options }),
        },
      }));
      return responses.length === 1
        ? responses[0]
        : responses;
    }
  );
  const provider: FetchProvider = {
    id,
    name: `Mock ${id}`,
    description: "mock fetch provider",
    supportsApiKey: false,
    requiresApiKey: false,
    fetch: fetchMock,
  };
  const registry = new ProviderRegistry();
  const module: ProviderModule = {
    id,
    name: provider.name,
    description: provider.description,
    capabilities: ["fetch"],
    fetchProvider: provider,
  };
  registry.registerProvider(module);
  return { provider, fetchMock, registry, module };
}

/** Execute the tool with a fresh abort signal, mirroring the Pi runtime. */
async function executeTool(
  tool: ReturnType<typeof createWebFetchTool>,
  params: WebFetchParams
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

describe("src/tools/web-fetch", () => {
  describe("webFetchSchema", () => {
    it("declares urls, url and maxCharacters parameters", () => {
      expect(Object.keys(webFetchSchema.properties)).toEqual([
        "urls",
        "url",
        "maxCharacters",
      ]);
    });

    it("makes urls and url optional in schema with runtime validation", () => {
      expect(webFetchSchema.required).toBeUndefined();
    });

    it("types urls as a union of string array or single string", () => {
      const urls = webFetchSchema.properties.urls as { anyOf: unknown[] };
      expect(urls.anyOf).toEqual([
        expect.objectContaining({
          type: "array",
          items: expect.objectContaining({ type: "string" }),
        }),
        expect.objectContaining({ type: "string" }),
      ]);
    });

    it("types url as optional string and maxCharacters as number", () => {
      expect(webFetchSchema.properties.url?.type).toBe("string");
      expect(webFetchSchema.properties.maxCharacters?.type).toBe("number");
    });
  });

  describe("prompt integration", () => {
    it("exposes the OpenCode-inspired snippet and guidelines", () => {
      expect(WEB_FETCH_PROMPT_SNIPPET).toBe(
        "Fetch full clean markdown content from one or multiple known webpage URLs"
      );
      expect(WEB_FETCH_PROMPT_GUIDELINES).toHaveLength(2);
      expect(WEB_FETCH_PROMPT_GUIDELINES[0]).toContain(
        "Use web_fetch to retrieve and analyze full content"
      );
      expect(WEB_FETCH_PROMPT_GUIDELINES[0]).toContain(
        "retrieval vs discovery"
      );
      expect(WEB_FETCH_PROMPT_GUIDELINES[1]).toContain("batch-fetch");
    });

    it("describes batch URL fetching and the web_search follow-up", () => {
      expect(WEB_FETCH_DESCRIPTION).toContain(
        "Read one or multiple webpage URLs"
      );
      expect(WEB_FETCH_DESCRIPTION).toContain(
        "batch processing of multiple URLs in a single call"
      );
      expect(WEB_FETCH_DESCRIPTION).toContain("web_search");
    });
  });

  describe("createWebFetchTool", () => {
    it("defines the web_fetch tool with schema, prompt fields and renderers", () => {
      const { registry } = createMockFetchProvider();
      const tool = createWebFetchTool(registry);

      expect(tool.name).toBe("web_fetch");
      expect(tool.label).toBe("web_fetch");
      expect(tool.parameters).toBe(webFetchSchema);
      expect(tool.description).toBe(WEB_FETCH_DESCRIPTION);
      expect(tool.promptSnippet).toBe(WEB_FETCH_PROMPT_SNIPPET);
      expect(tool.promptGuidelines).toEqual(WEB_FETCH_PROMPT_GUIDELINES);
      expect(typeof tool.renderCall).toBe("function");
      expect(typeof tool.renderResult).toBe("function");
    });

    it("resolves the active provider from the config and returns the extracted content", async () => {
      const { fetchMock, registry } = createMockFetchProvider();
      const tool = createWebFetchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });

      const result = await executeTool(tool, {
        urls: "https://example.com/article",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toEqual(["https://example.com/article"]);
      expect(options).toEqual({
        maxCharacters: WEB_FETCH_DEFAULT_MAX_CHARACTERS,
      });

      expect(result.details).toBeInstanceOf(Array);
      expect(result.details).toHaveLength(1);
      expect((result.details as FetchResponse[])[0].url).toBe(
        "https://example.com/article"
      );
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const text = textOf(result);
      expect(text).toContain(SECURITY_NOTICE_PREFIX);
      expect(text).toContain(
        '<web_content url="https://example.com/article" title="Example Article" domain="example.com">'
      );
      expect(text).toContain("# Article\n\nFull markdown content.");
      expect(text).toContain("</web_content>");
    });

    it("batch-fetches multiple URLs in a single provider call", async () => {
      const { fetchMock, registry } = createMockFetchProvider();
      const tool = createWebFetchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });

      const result = await executeTool(tool, {
        urls: ["https://a.com/one", "https://b.com/two"],
      });

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

      const text = textOf(result);
      expect(text).toContain(SECURITY_NOTICE_PREFIX);
      expect(text).toContain(
        '<web_content url="https://a.com/one" title="Example Article" domain="a.com">'
      );
      expect(text).toContain(
        '<web_content url="https://b.com/two" title="Example Article" domain="b.com">'
      );
    });

    it("accepts the optional url compatibility alias", async () => {
      const { fetchMock, registry } = createMockFetchProvider();
      const tool = createWebFetchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });

      const result = await executeTool(
        tool,
        { url: "https://example.com/alias" } as WebFetchParams
      );

      expect(fetchMock).toHaveBeenCalledWith(
        ["https://example.com/alias"],
        { maxCharacters: WEB_FETCH_DEFAULT_MAX_CHARACTERS },
        expect.any(AbortSignal)
      );
      const details = result.details as FetchResponse[];
      expect(details).toHaveLength(1);
      expect(details[0].url).toBe("https://example.com/alias");
    });

    it("rejects when neither urls nor url is provided", async () => {
      const { registry } = createMockFetchProvider();
      const tool = createWebFetchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });

      await expect(
        executeTool(tool, {} as WebFetchParams)
      ).rejects.toThrow(/requires at least one URL/);
    });

    it("passes an explicit maxCharacters through to the provider", async () => {
      const { fetchMock, registry } = createMockFetchProvider();
      const tool = createWebFetchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });

      await executeTool(tool, {
        urls: "https://example.com/long",
        maxCharacters: 500,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        ["https://example.com/long"],
        { maxCharacters: 500 },
        expect.any(AbortSignal)
      );
    });

    it("forwards the caller abort signal to the provider", async () => {
      const { fetchMock, registry } = createMockFetchProvider();
      const tool = createWebFetchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });
      const controller = new AbortController();

      await tool.execute(
        "call-2",
        { urls: "https://example.com/cancel" },
        controller.signal,
        undefined,
        undefined as unknown as ExtensionContext
      );

      expect(fetchMock).toHaveBeenCalledWith(
        ["https://example.com/cancel"],
        { maxCharacters: WEB_FETCH_DEFAULT_MAX_CHARACTERS },
        controller.signal
      );
    });

    it("defaults maxCharacters to 5000 when omitted", () => {
      expect(WEB_FETCH_DEFAULT_MAX_CHARACTERS).toBe(5000);
    });

    it("propagates provider errors", async () => {
      const boom = new Error("mock fetch failure");
      const { registry } = createMockFetchProvider("exa", boom);
      const tool = createWebFetchTool(registry, {
        getConfig: async () => mockConfig("exa"),
      });

      await expect(
        executeTool(tool, { urls: "https://example.com/boom" })
      ).rejects.toThrow("mock fetch failure");
    });

    it("throws a descriptive registry error for an unregistered provider", async () => {
      const { registry } = createMockFetchProvider();
      const tool = createWebFetchTool(registry, {
        getConfig: async () => mockConfig("missing"),
      });

      await expect(
        executeTool(tool, { urls: "https://example.com/no-provider" })
      ).rejects.toThrow(/Unknown provider "missing" for capability "fetch"/);
    });

    it("uses the real getConfig by default when none is injected", async () => {
      // Point PI_AGENT_DIR at an empty temp dir so the real config reader
      // falls back to the built-in defaults (fetch.provider = "exa").
      const prevAgentDir = process.env.PI_AGENT_DIR;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-scout-test-"));
      process.env.PI_AGENT_DIR = tmpDir;
      try {
        const { fetchMock, registry } = createMockFetchProvider();
        const tool = createWebFetchTool(registry);

        const result = await executeTool(tool, {
          urls: "https://example.com/defaults",
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect((result.details as FetchResponse[])[0].provider).toBe("exa");
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

  describe("formatFetchResult", () => {
    it("formats a single page with the security prefix and <web_content> wrap", () => {
      const text = formatFetchResult(sampleResponse());

      expect(text).toBe(
        [
          SECURITY_NOTICE_PREFIX,
          wrapWebContent({
            content: "# Article\n\nFull markdown content.",
            url: "https://example.com/article",
            title: "Example Article",
          }),
        ].join("\n")
      );
    });

    it("formats a batch of pages, one <web_content> block per page", () => {
      const text = formatFetchResult([
        {
          url: "https://a.com/one",
          title: "One",
          content: "first page",
          provider: "exa",
        },
        {
          url: "https://b.com/two",
          content: "second page",
          provider: "exa",
        },
      ]);

      expect(text).toBe(
        [
          SECURITY_NOTICE_PREFIX,
          wrapWebContent({
            content: "first page",
            url: "https://a.com/one",
            title: "One",
          }),
          wrapWebContent({
            content: "second page",
            url: "https://b.com/two",
          }),
        ].join("\n")
      );
    });

    it("reports per-page when no content could be extracted", () => {
      const text = formatFetchResult({
        url: "https://empty.example",
        content: "",
        provider: "exa",
      });

      expect(text).toBe(
        [
          SECURITY_NOTICE_PREFIX,
          'No content could be extracted from "https://empty.example".',
        ].join("\n")
      );
    });

    it("reports when no pages were returned at all", () => {
      expect(formatFetchResult([])).toBe(
        [SECURITY_NOTICE_PREFIX, "No web fetch results returned."].join("\n")
      );
    });
  });
});
