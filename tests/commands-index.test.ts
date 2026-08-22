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

  describe("text-mode subcommands", () => {
    it("shows the usage help via /ws help", async () => {
      const { ctx, notify } = mockCtx();
      const { pi } = mockPi();
      await handleWsCommand(ctx, ["help"], makeRegistry(), pi);
      expect(notify).toHaveBeenCalledTimes(1);
      const [message, type] = notify.mock.calls[0] as [string, string];
      expect(type).toBe("info");
      expect(message).toContain("/ws status");
      expect(message).toContain("/ws provider <tool> <id|none>");
    });

    it("notifies an error for unknown subcommands and shows the help", async () => {
      const { ctx, notify } = mockCtx();
      const { pi } = mockPi();
      await handleWsCommand(ctx, ["any", "args"], makeRegistry(), pi);
      expect(notify).toHaveBeenCalledTimes(1);
      const [message, type] = notify.mock.calls[0] as [string, string];
      expect(type).toBe("error");
      expect(message).toContain('Unknown subcommand "any"');
    });

    it("toggles a tool off and on via /ws search off|on", async () => {
      const { ctx, notify } = mockCtx();
      const { pi, setActiveTools } = mockPi();

      await handleWsCommand(ctx, ["search", "off"], makeRegistry(), pi);
      const configPath = path.join(tmpDir, "pi-web-search-and-fetch.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(config.search.enabled).toBe(false);

      await handleWsCommand(ctx, ["search", "on"], makeRegistry(), pi);
      const updated = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(updated.search.enabled).toBe(true);

      // The active tools were re-synchronized after each toggle.
      expect(setActiveTools).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledTimes(2);
    });

    it("assigns a provider in text mode via /ws provider search exa", async () => {
      const { ctx, notify } = mockCtx();
      const { pi } = mockPi();

      await handleWsCommand(ctx, ["provider", "search", "exa"], makeRegistry(), pi);
      const configPath = path.join(tmpDir, "pi-web-search-and-fetch.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(config.search.provider).toBe("exa");
      expect(config.search.enabled).toBe(true);
      expect(notify.mock.calls[0][0]).toContain('assigned to provider "exa"');
    });

    it("disables the tool while keeping the provider via /ws provider fetch none", async () => {
      const { ctx } = mockCtx();
      const { pi } = mockPi();

      await handleWsCommand(ctx, ["provider", "fetch", "none"], makeRegistry(), pi);
      const configPath = path.join(tmpDir, "pi-web-search-and-fetch.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(config.fetch.enabled).toBe(false);
      expect(config.fetch.provider).toBe("exa");
    });

    it("rejects an unknown provider id", async () => {
      const { ctx, notify } = mockCtx();
      const { pi } = mockPi();

      await handleWsCommand(
        ctx,
        ["provider", "deep", "does-not-exist"],
        makeRegistry(),
        pi
      );
      expect(notify).toHaveBeenCalledTimes(1);
      const [message, type] = notify.mock.calls[0] as [string, string];
      expect(type).toBe("error");
      expect(message).toContain('Unknown provider "does-not-exist"');
    });

    it("rejects a missing state argument with usage hint", async () => {
      const { ctx, notify } = mockCtx();
      const { pi } = mockPi();

      await handleWsCommand(ctx, ["deep"], makeRegistry(), pi);
      expect(notify).toHaveBeenCalledTimes(1);
      const [message, type] = notify.mock.calls[0] as [string, string];
      expect(type).toBe("error");
      expect(message).toContain("Usage: /ws deep on|off");
    });

    it("shows the status report via /ws status", async () => {
      const { ctx, notify } = mockCtx();
      const { pi } = mockPi();

      await handleWsCommand(ctx, ["status"], makeRegistry(), pi);
      expect(notify).toHaveBeenCalledTimes(1);
      const [message, type] = notify.mock.calls[0] as [string, string];
      expect(type).toBe("info");
      expect(message).toContain("Current Status");
    });

    it("requires the TUI for subcommands when pi is not available", async () => {
      const { ctx, notify } = mockCtx();
      await handleWsCommand(ctx, ["status"], makeRegistry());
      expect(notify).toHaveBeenCalledTimes(1);
      const [, type] = notify.mock.calls[0] as [string, string];
      expect(type).toBe("error");
    });
  });
});
