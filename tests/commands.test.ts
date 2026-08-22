/**
 * `tests/commands.test.ts` - Test suite for the `/ws` command.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeExaApiKey } from "../src/config/auth.js";
import {
  getConfigPath,
} from "../src/config/index.js";
import type {
  PiWebSearchAndFetchConfig,
} from "../src/config/types.js";
import {
  launchProviderConfigModal,
  runProviderConfigSelector,
} from "../src/commands/config.js";
import { handleWsHub } from "../src/commands/hub.js";
import {
  WS_USAGE,
  handleWsCommand,
} from "../src/commands/index.js";
import {
  buildWsStatusReport,
  handleWsStatus,
} from "../src/commands/status.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type {
  DeepSearchProvider,
  FetchProvider,
  ProviderModule,
  SearchProvider,
} from "../src/providers/types.js";

/** Identity mock theme for plain text asserts in TUI factories. */
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
    description: `test search provider ${name}`,
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
    description: `test fetch provider ${name}`,
    supportsApiKey: false,
    requiresApiKey: false,
    fetch: async (url: string) => ({ url, content: `Content from ${name}`, provider: id }),
  };
}

/** Builds a minimal deep-search provider for tests. */
function makeDeepSearchProvider(id: string, name: string): DeepSearchProvider {
  return {
    id,
    name,
    description: `test deep-search provider ${name}`,
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
    description: `Triple module ${id}`,
    capabilities: ["search", "fetch", "deep-search"],
    searchProvider: makeSearchProvider(id, name),
    fetchProvider: makeFetchProvider(id, name),
    deepSearchProvider: makeDeepSearchProvider(id, name),
    configure: vi.fn(async (ctx: ExtensionCommandContext) => {
      ctx.ui.notify(`Configured ${name}`, "info");
    }),
  };
}

/** Standard registry fixture with multiple test providers. */
function makeTestRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.registerProvider(makeTripleModule("exa", "Exa"));
  return registry;
}

/** Mock Pi ExtensionAPI with active tool tracking. */
function mockPi() {
  const setActiveTools = vi.fn(async (_tools: string[]) => {});
  const pi = { setActiveTools } as unknown as ExtensionAPI;
  return { pi, setActiveTools };
}

interface MockCommandCtx {
  ctx: ExtensionCommandContext;
  notify: ReturnType<typeof vi.fn>;
  custom: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
}

/** Creates a fully instrumented ExtensionCommandContext mock. */
function createMockCtx(currentModel?: unknown): MockCommandCtx {
  const notify = vi.fn((_message: string, _type?: "info" | "warning" | "error") => {});
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
  const select = vi.fn(async (_title: string, options: string[]) => options[0]);

  const ctx = {
    ui: { notify, custom, select },
    model: currentModel,
  } as unknown as ExtensionCommandContext;

  return { ctx, notify, custom, select };
}

/** Write helper for `pi-web-search-and-fetch.json`. */
function writeConfigFile(config: PiWebSearchAndFetchConfig): void {
  fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf8");
}

/** Write helper for `pi-requesty.json`. */
function writeRequestyFile(data: unknown): void {
  fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.PI_AGENT_DIR as string, "pi-requesty.json"),
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

describe("tests/commands.test.ts - /ws command & Hub execution", () => {
  let tmpDir: string;
  let registry: ProviderRegistry;
  const prevAgentDir = process.env.PI_AGENT_DIR;
  const prevExaKey = process.env.EXA_API_KEY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-commands-test-"));
    process.env.PI_AGENT_DIR = tmpDir;
    delete process.env.EXA_API_KEY;
    registry = makeTestRegistry();
  });

  afterEach(() => {
    if (prevAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = prevAgentDir;
    }
    if (prevExaKey === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = prevExaKey;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("1. Command Execution: handleWsCommand", () => {
    it("opens Hub when called with pi available", async () => {
      const { ctx, custom } = createMockCtx();
      const { pi } = mockPi();

      await handleWsCommand(ctx, [], registry, pi);

      expect(custom).toHaveBeenCalledTimes(1);
    });

    it("notifies an error when called without pi", async () => {
      const { ctx, notify } = createMockCtx();

      await handleWsCommand(ctx, [], registry, undefined);

      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(WS_USAGE),
        "error"
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("the interactive Hub requires Pi's TUI"),
        "error"
      );
    });
  });

  describe("2. Status Subsystem", () => {
    it("renders default configuration state and notification", async () => {
      const { ctx, notify } = createMockCtx();

      await handleWsStatus(ctx);

      expect(notify).toHaveBeenCalledTimes(1);
      const message = notify.mock.calls[0][0];
      expect(notify.mock.calls[0][1]).toBe("info");

      expect(message).toContain("Web Search and Fetch — Current Status");
      expect(message).toContain("[✓] Search (web_search) : ON (Provider: exa)");
      expect(message).toContain("[✓] Fetch (web_fetch) : ON (Provider: exa)");
      expect(message).toContain("[ ] Deep Search (web_deep_search) : OFF (Provider: exa)");
      expect(message).toContain("Exa: without API Key (free public mode, global limits)");
      expect(message).toContain("nativeSearch: disabled");
    });

    it("masks API key when configured in auth.json", async () => {
      await writeExaApiKey("sk-exa-1234567890abcdef");
      const report = await buildWsStatusReport();

      expect(report).toContain("Exa: API Key detected in auth.json (sk-e••••cdef)");
    });

    it("masks API key when configured in EXA_API_KEY environment variable", async () => {
      process.env.EXA_API_KEY = "env-secret-key-9999";
      const report = await buildWsStatusReport();

      expect(report).toContain("Exa: API Key detected in EXA_API_KEY (environment) (env-••••9999)");
    });

    it("reflects pi-requesty native search and model suppression", async () => {
      writeRequestyFile({ nativeSearch: true });
      const requestySupportedModel = {
        provider: "requesty",
        id: "anthropic/claude-3-5-sonnet",
        supportsWebSearch: true,
      };

      const report = await buildWsStatusReport(requestySupportedModel);

      expect(report).toContain("[✓] Search (web_search) : ON (Provider: exa) (suppressed: Requesty native search is active for the current model; web_search is suppressed to avoid duplication)");
      expect(report).toContain("nativeSearch: enabled");
      expect(report).toContain("web_search: suppressed");
    });
  });

  describe("3. Config Modal Launch", () => {
    it("calls module.configure for launchProviderConfigModal", async () => {
      const { ctx, notify } = createMockCtx();

      await launchProviderConfigModal(ctx, registry, "exa");

      expect(notify).toHaveBeenCalledWith("Configured Exa", "info");
    });

    it("delegates to runProviderConfigSelector for single provider", async () => {
      const { ctx, notify } = createMockCtx();

      await runProviderConfigSelector(ctx, registry);

      expect(notify).toHaveBeenCalledWith("Configured Exa", "info");
    });
  });

  describe("4. Interactive Hub: handleWsHub", () => {
    it("opens Hub TUI overlay and exits without action when exit is selected", async () => {
      const { ctx, custom, notify } = createMockCtx();
      const { pi } = mockPi();

      await handleWsHub(ctx, registry, pi);

      expect(custom).toHaveBeenCalledTimes(1);
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
