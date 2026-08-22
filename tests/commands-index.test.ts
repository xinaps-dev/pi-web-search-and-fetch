import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_USAGE, handleWsCommand } from "../src/commands/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type {
  DeepSearchProvider,
  FetchProvider,
  ProviderModule,
  SearchProvider,
} from "../src/providers/types.js";

/** Identity mock theme: returns the text unchanged (plain-text asserts). */
function mockTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

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

/**
 * Registry with a triple-capability `exa`
 */
function makeRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.registerProvider(makeTripleModule("exa", "Exa"));
  return registry;
}

/**
 * Build a mock Pi extension API that records `setActiveTools` calls.
 */
function mockPi() {
  const setActiveTools = vi.fn(async (_tools: string[]) => {
    void _tools;
  });
  const pi = { setActiveTools } as unknown as ExtensionAPI;
  return { pi, setActiveTools };
}

interface MockCtx {
  ctx: ExtensionCommandContext;
  notify: ReturnType<typeof vi.fn>;
  custom: ReturnType<typeof vi.fn>;
}

/**
 * Build a mock command context with `ui.notify` and `ui.custom` spies.
 */
function mockCtx(): MockCtx {
  const notify = vi.fn((_message: string, _type?: string) => {
    void _message;
    void _type;
  });
  const custom = vi.fn(
    async (
      factory: (
        tui: unknown,
        theme: Theme,
        kb: unknown,
        done: (value?: unknown) => void
      ) => unknown
    ) => {
      const done = vi.fn();
      const component = await factory(undefined, mockTheme(), undefined, done);
      done(undefined);
      return component;
    }
  );
  const ctx = {
    ui: { notify, custom },
    model: undefined,
  } as unknown as ExtensionCommandContext;
  return { ctx, notify, custom };
}

describe("src/commands/index /ws command handler", () => {
  let tmpDir: string;
  const prevAgentDir = process.env.PI_AGENT_DIR;
  const prevExaApiKey = process.env.EXA_API_KEY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-ws-router-"));
    process.env.PI_AGENT_DIR = tmpDir;
    delete process.env.EXA_API_KEY;
  });

  afterEach(() => {
    if (prevAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = prevAgentDir;
    }
    if (prevExaApiKey === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = prevExaApiKey;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("dispatch to Hub", () => {
    it("opens the interactive hub overlay when pi is provided", async () => {
      const { ctx, custom } = mockCtx();
      const { pi } = mockPi();
      await handleWsCommand(ctx, [], makeRegistry(), pi);
      expect(custom).toHaveBeenCalledTimes(1);
    });

    it("opens the interactive hub regardless of extra arguments", async () => {
      const { ctx, custom } = mockCtx();
      const { pi } = mockPi();
      await handleWsCommand(ctx, ["any", "args"], makeRegistry(), pi);
      expect(custom).toHaveBeenCalledTimes(1);
    });

    it("notifies an error when pi is not available", async () => {
      const { ctx, notify } = mockCtx();
      await handleWsCommand(ctx, [], makeRegistry());
      expect(notify).toHaveBeenCalledTimes(1);
      const [message, type] = notify.mock.calls[0] as [string, string];
      expect(type).toBe("error");
      expect(message).toContain(WS_USAGE);
      expect(message).toContain("the interactive Hub requires Pi's TUI");
    });
  });
});
