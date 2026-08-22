import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfigPath } from "../src/config/index.js";
import type {
  PiWebSearchAndFetchConfig,
  WsToolConfig,
} from "../src/config/types.js";
import { syncActiveTools } from "../src/tools/sync.js";

/**
 * Build a mock `ExtensionAPI` that records `setActiveTools` calls and
 * optionally simulates tools already active in the session.
 */
function mockPi(initialActiveTools: string[] = []) {
  const setActiveTools = vi.fn((_toolNames: string[]) => {});
  const getActiveTools = vi.fn(() => initialActiveTools);
  const pi = { setActiveTools, getActiveTools } as unknown as ExtensionAPI;
  return { pi, setActiveTools, getActiveTools };
}

/** Write a full `pi-web-search-and-fetch.json` into the temp agent directory. */
function writeConfig(config: PiWebSearchAndFetchConfig): void {
  fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config), "utf8");
}

function writeRequestyConfig(data: unknown): void {
  fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.PI_AGENT_DIR as string, "pi-requesty.json"),
    JSON.stringify(data),
    "utf8"
  );
}

function baseConfig(
  search?: Partial<WsToolConfig>,
  fetch?: Partial<WsToolConfig>,
  deepSearch?: Partial<WsToolConfig>
): PiWebSearchAndFetchConfig {
  return {
    search: { enabled: true, provider: "exa", ...search },
    fetch: { enabled: true, provider: "exa", ...fetch },
    deepSearch: { enabled: false, provider: "exa", ...deepSearch },
    providers: { exa: { useApiKey: true } },
  };
}

describe("src/tools/sync", () => {
  let tmpDir: string;
  const prevAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-sync-"));
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

  describe("config-driven activation", () => {
    it("activates web_search and web_fetch by default (no config file)", async () => {
      const { pi, setActiveTools } = mockPi();
      await syncActiveTools(pi);
      expect(setActiveTools).toHaveBeenCalledTimes(1);
      expect(setActiveTools).toHaveBeenCalledWith(["web_search", "web_fetch"]);
    });

    it("activates all three tools when every section is enabled", async () => {
      writeConfig(baseConfig(undefined, undefined, { enabled: true }));
      const { pi, setActiveTools } = mockPi();
      await syncActiveTools(pi);
      expect(setActiveTools).toHaveBeenCalledWith([
        "web_search",
        "web_fetch",
        "web_deep_search",
      ]);
    });

    it("excludes web_search when search.enabled is false", async () => {
      writeConfig(baseConfig({ enabled: false }));
      const { pi, setActiveTools } = mockPi();
      await syncActiveTools(pi);
      expect(setActiveTools).toHaveBeenCalledWith(["web_fetch"]);
    });

    it("excludes web_fetch when fetch.enabled is false", async () => {
      writeConfig(baseConfig(undefined, { enabled: false }));
      const { pi, setActiveTools } = mockPi();
      await syncActiveTools(pi);
      expect(setActiveTools).toHaveBeenCalledWith(["web_search"]);
    });

    it("excludes web_deep_search when deepSearch.enabled is false", async () => {
      writeConfig(baseConfig());
      const { pi, setActiveTools } = mockPi();
      await syncActiveTools(pi);
      expect(setActiveTools).toHaveBeenCalledWith(["web_search", "web_fetch"]);
    });

    it("activates no tools when every section is disabled", async () => {
      writeConfig(
        baseConfig({ enabled: false }, { enabled: false }, { enabled: false })
      );
      const { pi, setActiveTools } = mockPi();
      await syncActiveTools(pi);
      expect(setActiveTools).toHaveBeenCalledWith([]);
    });
  });

  describe("pi-requesty suppression rules", () => {
    it("suppresses web_search for a compatible Requesty model but keeps web_fetch", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const { pi, setActiveTools } = mockPi();
      await syncActiveTools(pi, {
        provider: "requesty",
        id: "gpt-4o",
        supportsWebSearch: true,
      });
      expect(setActiveTools).toHaveBeenCalledWith(["web_fetch"]);
    });

    it("suppresses web_search even when deep search is enabled", async () => {
      writeRequestyConfig({ nativeSearch: true });
      writeConfig(baseConfig(undefined, undefined, { enabled: true }));
      const { pi, setActiveTools } = mockPi();
      await syncActiveTools(pi, {
        provider: "requesty",
        id: "gpt-4o",
        supportsWebSearch: true,
      });
      expect(setActiveTools).toHaveBeenCalledWith([
        "web_fetch",
        "web_deep_search",
      ]);
    });

    it("keeps web_search for Gemini models even with native search enabled", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const { pi, setActiveTools } = mockPi();
      await syncActiveTools(pi, {
        provider: "requesty",
        id: "gemini-2.0-pro",
        supportsWebSearch: true,
      });
      expect(setActiveTools).toHaveBeenCalledWith(["web_search", "web_fetch"]);
    });

    it("keeps web_search when pi-requesty nativeSearch is disabled", async () => {
      writeRequestyConfig({ nativeSearch: false });
      const { pi, setActiveTools } = mockPi();
      await syncActiveTools(pi, {
        provider: "requesty",
        id: "gpt-4o",
        supportsWebSearch: true,
      });
      expect(setActiveTools).toHaveBeenCalledWith(["web_search", "web_fetch"]);
    });

    it("keeps web_search for non-Requesty models", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const { pi, setActiveTools } = mockPi();
      await syncActiveTools(pi, {
        provider: "openai",
        id: "gpt-4o",
        supportsWebSearch: true,
      });
      expect(setActiveTools).toHaveBeenCalledWith(["web_search", "web_fetch"]);
    });

    it("keeps web_search when currentModel is omitted", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const { pi, setActiveTools } = mockPi();
      await syncActiveTools(pi);
      expect(setActiveTools).toHaveBeenCalledWith(["web_search", "web_fetch"]);
    });
  });

  describe("consolidated standard tools bound", () => {
    it("never activates tools outside the 3 consolidated standard Search and Fetch tools", async () => {
      writeConfig(baseConfig(undefined, undefined, { enabled: true }));
      const { pi, setActiveTools } = mockPi(["read", "bash"]);
      await syncActiveTools(pi);
      const standardTools = new Set([
        "web_search",
        "web_fetch",
        "web_deep_search",
      ]);
      const sessionTools = new Set(["read", "bash"]);
      const activated = setActiveTools.mock.calls[0][0];
      expect(activated.length).toBeLessThanOrEqual(5);
      for (const id of activated) {
        expect(standardTools.has(id) || sessionTools.has(id)).toBe(true);
      }
    });
  });

  describe("preserving non-search-and-fetch tools from the session", () => {
    it("preserves non-search-and-fetch tools when enabling Search and Fetch tools", async () => {
      const { pi, setActiveTools } = mockPi(["read", "bash"]);
      await syncActiveTools(pi);
      expect(setActiveTools).toHaveBeenCalledWith([
        "read",
        "bash",
        "web_search",
        "web_fetch",
      ]);
    });

    it("preserves non-search-and-fetch tools when every Search and Fetch tool is disabled", async () => {
      writeConfig(
        baseConfig({ enabled: false }, { enabled: false }, { enabled: false })
      );
      const { pi, setActiveTools } = mockPi(["read", "bash", "edit"]);
      await syncActiveTools(pi);
      expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", "edit"]);
    });

    it("preserves non-search-and-fetch tools and drops Search and Fetch tools on suppression", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const { pi, setActiveTools } = mockPi([
        "read",
        "web_search",
        "web_fetch",
        "bash",
      ]);
      await syncActiveTools(pi, {
        provider: "requesty",
        id: "gpt-4o",
        supportsWebSearch: true,
      });
      expect(setActiveTools).toHaveBeenCalledWith([
        "read",
        "bash",
        "web_fetch",
      ]);
    });

    it("does not duplicate Search and Fetch tools already active in the session", async () => {
      const { pi, setActiveTools } = mockPi(["web_search", "web_fetch"]);
      await syncActiveTools(pi);
      expect(setActiveTools).toHaveBeenCalledWith(["web_search", "web_fetch"]);
    });

    it("works when pi.getActiveTools is undefined (safe fallback)", async () => {
      const setActiveTools = vi.fn((_toolNames: string[]) => {});
      const pi = { setActiveTools } as unknown as ExtensionAPI;
      await syncActiveTools(pi);
      expect(setActiveTools).toHaveBeenCalledWith(["web_search", "web_fetch"]);
    });
  });
});
