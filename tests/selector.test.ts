import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, updateConfig } from "../src/config/index.js";
import type {
  DeepSearchProvider,
  FetchProvider,
  ProviderModule,
  SearchProvider,
} from "../src/providers/types.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import {
  NONE_PROVIDER,
  buildProviderSelectorSteps,
  runProviderSelector,
  type ProviderSelectionResult,
} from "../src/ui/selector.js";

/** Builds a minimal search provider for tests. */
function makeSearchProvider(id: string, name: string): SearchProvider {
  return {
    id,
    name,
    description: "test search provider",
    supportsApiKey: false,
    requiresApiKey: false,
    search: async (query) => ({ query, results: [], provider: id }),
  };
}

/** Builds a minimal fetch provider for tests. */
function makeFetchProvider(id: string, name: string): FetchProvider {
  return {
    id,
    name,
    description: "test fetch provider",
    supportsApiKey: false,
    requiresApiKey: false,
    fetch: async (url: string) => ({ url, content: "", provider: id }),
  };
}

/** Builds a minimal deep-search provider for tests. */
function makeDeepSearchProvider(id: string, name: string): DeepSearchProvider {
  return {
    id,
    name,
    description: "test deep-search provider",
    supportsApiKey: true,
    requiresApiKey: true,
    deepSearch: async (query) => ({ query, results: [], provider: id }),
  };
}

/** Builds a triple-capability provider module for tests. */
function makeTripleModule(id: string, name: string): ProviderModule {
  return {
    id,
    name,
    description: `test module ${id}`,
    capabilities: ["search", "fetch", "deep-search"],
    searchProvider: makeSearchProvider(id, name),
    fetchProvider: makeFetchProvider(id, name),
    deepSearchProvider: makeDeepSearchProvider(id, name),
  };
}

/** Builds a search-only provider module for tests. */
function makeSearchOnlyModule(id: string, name: string): ProviderModule {
  return {
    id,
    name,
    description: `search-only module ${id}`,
    capabilities: ["search"],
    searchProvider: makeSearchProvider(id, name),
  };
}

/** Registry with a triple-capability `exa` and a search-only `brave`. */
function makeRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.registerProvider(makeTripleModule("exa", "Exa"));
  registry.registerProvider(makeSearchOnlyModule("brave", "Brave"));
  return registry;
}

/**
 * Build a mock `ExtensionAPI` that records `setActiveTools` calls.
 */
function mockPi(initialActiveTools: string[] = []) {
  const setActiveTools = vi.fn((_toolNames: string[]) => {});
  const getActiveTools = vi.fn(() => initialActiveTools);
  const pi = { setActiveTools, getActiveTools } as unknown as ExtensionAPI;
  return { pi, setActiveTools, getActiveTools };
}

interface MockCtx {
  ctx: ExtensionCommandContext;
  select: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
}

/**
 * Build a mock command context whose `ui.select` returns the scripted
 * choices one per dialog and whose `ui.notify` is a spy.
 */
function mockCtx(scripted: (string | undefined)[]): MockCtx {
  const select = vi.fn(async (title: string, options: string[]) => {
    void title;
    void options;
    return scripted.shift();
  });
  const notify = vi.fn((message: string, type?: string) => {
    void message;
    void type;
  });
  const ctx = {
    ui: { select, notify },
    model: undefined,
  } as unknown as ExtensionCommandContext;
  return { ctx, select, notify };
}

describe("src/ui/selector", () => {
  let tmpDir: string;
  const prevAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-selector-"));
    process.env.PI_AGENT_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = prevAgentDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("buildProviderSelectorSteps", () => {
    it("builds 3 steps: search, fetch and deep-search, each with `none`", () => {
      const steps = buildProviderSelectorSteps(makeRegistry());

      expect(steps).toHaveLength(3);

      const step1 = steps[0];
      expect(step1.section).toBe("search");
      expect(step1.toolId).toBe("web_search");
      expect(step1.options).toEqual(["Exa", "Brave", NONE_PROVIDER]);
      expect(step1.providerIds).toEqual(["exa", "brave", null]);

      const step2 = steps[1];
      expect(step2.section).toBe("fetch");
      expect(step2.toolId).toBe("web_fetch");
      // Only `exa` implements "fetch".
      expect(step2.options).toEqual(["Exa", NONE_PROVIDER]);
      expect(step2.providerIds).toEqual(["exa", null]);

      const step3 = steps[2];
      expect(step3.section).toBe("deepSearch");
      expect(step3.toolId).toBe("web_deep_search");
      // Only `exa` implements "deep-search".
      expect(step3.options).toEqual(["Exa", NONE_PROVIDER]);
      expect(step3.providerIds).toEqual(["exa", null]);
    });

    it("falls back to the provider id when two providers share a name", () => {
      const registry = new ProviderRegistry();
      registry.registerProvider(makeSearchOnlyModule("a", "Same Name"));
      registry.registerProvider(makeSearchOnlyModule("b", "Same Name"));

      const steps = buildProviderSelectorSteps(registry);
      const step1 = steps[0];
      expect(step1.options).toEqual(["Same Name", "b", NONE_PROVIDER]);
      expect(step1.providerIds).toEqual(["a", "b", null]);
    });
  });

  describe("runProviderSelector", () => {
    it("persists the 3 selections and syncs the active tools", async () => {
      const { ctx, select, notify } = mockCtx([
        "Brave",
        "Exa",
        NONE_PROVIDER,
      ]);
      const { pi, setActiveTools } = mockPi();

      const result = await runProviderSelector(ctx, makeRegistry(), pi);

      expect(select).toHaveBeenCalledTimes(3);
      expect(result).toEqual({
        cancelled: false,
        selections: [
          { section: "search", toolId: "web_search", providerId: "brave" },
          { section: "fetch", toolId: "web_fetch", providerId: "exa" },
          {
            section: "deepSearch",
            toolId: "web_deep_search",
            providerId: null,
          },
        ],
      });

      const config = await getConfig();
      expect(config.search).toEqual({ enabled: true, provider: "brave" });
      expect(config.fetch).toEqual({ enabled: true, provider: "exa" });
      expect(config.deepSearch).toEqual({ enabled: false, provider: "exa" });

      // Immediate tool synchronization: deep search disabled, so only
      // web_search and web_fetch are active.
      expect(setActiveTools).toHaveBeenCalledTimes(1);
      expect(setActiveTools).toHaveBeenCalledWith([
        "web_search",
        "web_fetch",
      ]);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("selecting `none` disables the tool and keeps its provider id", async () => {
      const { ctx } = mockCtx([NONE_PROVIDER, "Exa", "Exa"]);
      const { pi, setActiveTools } = mockPi();

      const result = await runProviderSelector(ctx, makeRegistry(), pi);
      expect(result.cancelled).toBe(false);

      const config = await getConfig();
      expect(config.search).toEqual({ enabled: false, provider: "exa" });
      expect(config.fetch).toEqual({ enabled: true, provider: "exa" });
      expect(config.deepSearch).toEqual({ enabled: true, provider: "exa" });

      // web_search disabled → only web_fetch and web_deep_search active.
      expect(setActiveTools).toHaveBeenCalledWith([
        "web_fetch",
        "web_deep_search",
      ]);
    });

    it("re-enables a previously disabled tool when a provider is chosen", async () => {
      // Pre-existing config with deep search disabled.
      await updateConfig({ deepSearch: { enabled: false, provider: "exa" } });

      const { ctx } = mockCtx(["Exa", "Exa", "Exa"]);
      const { pi, setActiveTools } = mockPi();

      await runProviderSelector(ctx, makeRegistry(), pi);

      const config = await getConfig();
      expect(config.deepSearch).toEqual({ enabled: true, provider: "exa" });
      expect(setActiveTools).toHaveBeenCalledWith([
        "web_search",
        "web_fetch",
        "web_deep_search",
      ]);
    });

    it("cancels without persisting when a step returns undefined", async () => {
      const { ctx, select, notify } = mockCtx(["Exa", undefined, "Exa"]);
      const { pi, setActiveTools } = mockPi();
      const before = await getConfig();

      const result: ProviderSelectionResult = await runProviderSelector(
        ctx,
        makeRegistry(),
        pi
      );

      expect(select).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ cancelled: true, selections: [] });
      expect(setActiveTools).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(await getConfig()).toEqual(before);
    });

    it("cancels on the very first step", async () => {
      const { ctx, select } = mockCtx([undefined]);
      const { pi, setActiveTools } = mockPi();

      const result = await runProviderSelector(ctx, makeRegistry(), pi);

      expect(select).toHaveBeenCalledTimes(1);
      expect(result.cancelled).toBe(true);
      expect(setActiveTools).not.toHaveBeenCalled();
    });
  });
});
