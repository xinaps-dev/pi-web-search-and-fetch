import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  launchProviderConfigModal,
  runProviderConfigSelector,
} from "../src/commands/config.js";
import { getConfigPath } from "../src/config/index.js";
import type { PiWebScoutConfig } from "../src/config/types.js";
import { exaProviderModule } from "../src/providers/exa/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type {
  FetchProvider,
  ProviderModule,
  SearchProvider,
} from "../src/providers/types.js";
import type { FormComponent } from "../src/ui/forms.js";

/** Raw terminal sequences (see pi-tui keys.js). */
const ESC = "\x1b";
const ENTER = "\r";

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

/** Builds a fetch-only provider module for tests without configure method. */
function makeFetchOnlyModule(id: string, name: string): ProviderModule {
  return {
    id,
    name,
    description: `fetch-only module ${id}`,
    capabilities: ["fetch"],
    fetchProvider: makeFetchProvider(id, name),
  };
}

/** Builds a configurable test module. */
function makeConfigurableModule(id: string, name: string): ProviderModule {
  return {
    id,
    name,
    description: `configurable module ${id}`,
    capabilities: ["search"],
    searchProvider: makeSearchProvider(id, name),
    configure: vi.fn(async (ctx: ExtensionCommandContext) => {
      ctx.ui.notify(`Configured ${name}`, "info");
    }),
  };
}

/**
 * Registry with `exa`, `jina` (no config) and `custom` (with config).
 */
function makeRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.registerProvider(exaProviderModule);
  registry.registerProvider(makeFetchOnlyModule("jina", "Jina Reader"));
  registry.registerProvider(makeConfigurableModule("custom", "Custom Search"));
  return registry;
}

interface MockCtx {
  ctx: ExtensionCommandContext;
  custom: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  getComponent: () => FormComponent | undefined;
  getDone: () => ReturnType<typeof vi.fn> | undefined;
}

/**
 * Build a mock command context whose `ui.custom` actually invokes the
 * overlay factory (with a mock theme and a `done` spy) and whose
 * `ui.notify` and `ui.select` are spies.
 */
function mockCtx(): MockCtx {
  let component: FormComponent | undefined;
  let done: ReturnType<typeof vi.fn> | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const custom = vi.fn(async (factory: any) => {
    const doneSpy = vi.fn();
    done = doneSpy;
    component = (await factory(null, mockTheme(), null, doneSpy)) as FormComponent;
  });
  const notify = vi.fn((_message: string, _type?: string) => {
    void _message;
    void _type;
  });
  const select = vi.fn(async (_title: string, options: string[]) => options[0]);

  const ctx = { ui: { custom, notify, select } } as unknown as ExtensionCommandContext;
  return {
    ctx,
    custom,
    notify,
    select,
    getComponent: () => component,
    getDone: () => done,
  };
}

/** Write a full `pi-web-scout.json` into the temp agent directory. */
function writeConfig(config: PiWebScoutConfig): void {
  fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config), "utf8");
}

function baseConfig(
  overrides: Partial<{
    searchEnabled: boolean;
    searchProvider: string;
    fetchEnabled: boolean;
    fetchProvider: string;
    deepEnabled: boolean;
    deepProvider: string;
    useApiKey: boolean;
  }> = {}
): PiWebScoutConfig {
  return {
    search: {
      enabled: overrides.searchEnabled ?? true,
      provider: overrides.searchProvider ?? "exa",
    },
    fetch: {
      enabled: overrides.fetchEnabled ?? true,
      provider: overrides.fetchProvider ?? "exa",
    },
    deepSearch: {
      enabled: overrides.deepEnabled ?? false,
      provider: overrides.deepProvider ?? "exa",
    },
    providers: { exa: { useApiKey: overrides.useApiKey ?? true } },
  };
}

describe("src/commands/config", () => {
  let tmpDir: string;
  const prevAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-scout-config-"));
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

  describe("launchProviderConfigModal", () => {
    it("invokes module.configure for 'exa' opening its modal", async () => {
      writeConfig(baseConfig());
      const mock = mockCtx();
      const registry = makeRegistry();

      await launchProviderConfigModal(mock.ctx, registry, "exa");

      expect(mock.custom).toHaveBeenCalledTimes(1);
      expect(mock.notify).not.toHaveBeenCalled();
      expect(mock.getComponent()).toBeDefined();
    });

    it("rejects an unknown provider with an error notification", async () => {
      writeConfig(baseConfig());
      const { ctx, custom, notify } = mockCtx();
      const registry = makeRegistry();

      await launchProviderConfigModal(ctx, registry, "tavily");

      expect(custom).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledTimes(1);
      const [message, type] = notify.mock.calls[0] as [string, "error"];
      expect(type).toBe("error");
      expect(message).toContain("tavily");
    });

    it("shows info for a registered provider without configure method", async () => {
      writeConfig(baseConfig());
      const { ctx, custom, notify } = mockCtx();
      const registry = makeRegistry();

      await launchProviderConfigModal(ctx, registry, "jina");

      expect(custom).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledTimes(1);
      const [message, type] = notify.mock.calls[0] as [string, "info"];
      expect(type).toBe("info");
      expect(message).toContain("Jina Reader");
    });

    it("resolves on save after persistence for Exa modal", async () => {
      writeConfig(baseConfig({ useApiKey: false }));
      const mock = mockCtx();
      const registry = makeRegistry();

      await launchProviderConfigModal(mock.ctx, registry, "exa");

      const form = mock.getComponent();
      expect(form).toBeDefined();
      form?.handleInput(" ");
      form?.handleInput(ENTER);
      await vi.waitFor(() => {
        expect(mock.getDone()).toBeDefined();
        expect(mock.getDone()).toHaveBeenCalledTimes(1);
      });
    });

    it("resolves on cancel (Escape)", async () => {
      writeConfig(baseConfig());
      const mock = mockCtx();
      const registry = makeRegistry();

      await launchProviderConfigModal(mock.ctx, registry, "exa");

      const form = mock.getComponent();
      expect(form).toBeDefined();
      form?.handleInput(ESC);
      await vi.waitFor(() => {
        expect(mock.getDone()).toBeDefined();
        expect(mock.getDone()).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("runProviderConfigSelector", () => {
    it("notifies error when no providers are registered", async () => {
      const { ctx, notify } = mockCtx();
      const emptyRegistry = new ProviderRegistry();

      await runProviderConfigSelector(ctx, emptyRegistry);

      expect(notify).toHaveBeenCalledWith("No providers are registered.", "error");
    });

    it("prompts with ui.select even when only 1 provider is registered", async () => {
      writeConfig(baseConfig());
      const mock = mockCtx();
      const singleRegistry = new ProviderRegistry();
      singleRegistry.registerProvider(exaProviderModule);

      await runProviderConfigSelector(mock.ctx, singleRegistry);

      expect(mock.select).toHaveBeenCalledWith(
        "Select a provider to configure:",
        ["Exa"]
      );
      expect(mock.custom).toHaveBeenCalledTimes(1);
    });

    it("prompts with ui.select when multiple providers are registered", async () => {
      const mock = mockCtx();
      const registry = makeRegistry();
      mock.select.mockResolvedValueOnce("Custom Search");

      await runProviderConfigSelector(mock.ctx, registry);

      expect(mock.select).toHaveBeenCalledWith(
        "Select a provider to configure:",
        expect.arrayContaining(["Exa", "Jina Reader", "Custom Search"])
      );
      expect(mock.notify).toHaveBeenCalledWith("Configured Custom Search", "info");
    });

    it("does nothing when the user cancels the select prompt", async () => {
      const mock = mockCtx();
      const registry = makeRegistry();
      mock.select.mockResolvedValueOnce(undefined);

      await runProviderConfigSelector(mock.ctx, registry);

      expect(mock.custom).not.toHaveBeenCalled();
      expect(mock.notify).not.toHaveBeenCalled();
    });
  });
});
