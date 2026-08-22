import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeExaApiKey } from "../src/config/auth.js";
import { getConfigPath } from "../src/config/index.js";
import type {
  PiWebSearchAndFetchConfig,
  WsToolConfig,
} from "../src/config/types.js";
import { buildWsStatusReport, handleWsStatus } from "../src/commands/status.js";

/**
 * Build a mock command context that records `ui.notify` calls and
 * optionally carries the current model.
 */
function mockCtx(currentModel?: unknown) {
  const notify = vi.fn((_message: string, _type?: "info" | "warning" | "error") => {});
  const ctx = {
    ui: { notify },
    model: currentModel,
  } as unknown as ExtensionCommandContext;
  return { ctx, notify };
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
  deepSearch?: Partial<WsToolConfig>,
  useApiKey = true
): PiWebSearchAndFetchConfig {
  return {
    search: { enabled: true, provider: "exa", ...search },
    fetch: { enabled: true, provider: "exa", ...fetch },
    deepSearch: { enabled: false, provider: "exa", ...deepSearch },
    providers: { exa: { useApiKey } },
  };
}

describe("src/commands/status", () => {
  let tmpDir: string;
  const prevAgentDir = process.env.PI_AGENT_DIR;
  const prevExaApiKey = process.env.EXA_API_KEY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-status-"));
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

  describe("buildWsStatusReport: tools section", () => {
    it("shows default tool states and providers (no config file)", async () => {
      const report = await buildWsStatusReport();
      expect(report).toContain("🌐 Web Search and Fetch — Current Status");
      expect(report).toContain("Tools:");
      expect(report).toContain(
        "[✓] Search (web_search) : ON (Provider: exa)"
      );
      expect(report).toContain(
        "[✓] Fetch (web_fetch) : ON (Provider: exa)"
      );
      expect(report).toContain(
        "[ ] Deep Search (web_deep_search) : OFF (Provider: exa)"
      );
    });

    it("reflects enabled states and provider ids from the config", async () => {
      writeConfig(
        baseConfig(
          { enabled: false, provider: "other" },
          { provider: "other" },
          { enabled: true, provider: "other" }
        )
      );
      const report = await buildWsStatusReport();
      expect(report).toContain(
        "[ ] Search (web_search) : OFF (Provider: other)"
      );
      expect(report).toContain(
        "[✓] Fetch (web_fetch) : ON (Provider: other)"
      );
      expect(report).toContain(
        "[✓] Deep Search (web_deep_search) : ON (Provider: other)"
      );
    });
  });

  describe("buildWsStatusReport: credentials section", () => {
    it("reports public free mode when no API key is available", async () => {
      const report = await buildWsStatusReport();
      expect(report).toContain("Credentials:");
      expect(report).toContain(
        "Exa: without API Key (free public mode, global limits)"
      );
    });

    it("reports a key stored in auth.json, masked and with its source", async () => {
      writeExaApiKey("sk-abcdefghijklmnop");
      const report = await buildWsStatusReport();
      expect(report).toContain(
        "Exa: API Key detected in auth.json (sk-a••••mnop)"
      );
      expect(report).not.toContain("sk-abcdefghijklmnop");
    });

    it("reports a key from the EXA_API_KEY environment variable", async () => {
      process.env.EXA_API_KEY = "sk-env-1234567890";
      const report = await buildWsStatusReport();
      expect(report).toContain(
        "Exa: API Key detected in EXA_API_KEY (environment) (sk-e••••7890)"
      );
    });

    it("prefers the auth.json key over the environment variable", async () => {
      writeExaApiKey("sk-stored-abcdefgh");
      process.env.EXA_API_KEY = "sk-env-1234567890";
      const report = await buildWsStatusReport();
      expect(report).toContain("API Key detected in auth.json");
      expect(report).not.toContain("EXA_API_KEY (environment)");
    });

    it("reports public mode when useApiKey is false, even with keys present", async () => {
      writeConfig(baseConfig(undefined, undefined, undefined, false));
      writeExaApiKey("sk-abcdefghijklmnop");
      process.env.EXA_API_KEY = "sk-env-1234567890";
      const report = await buildWsStatusReport();
      expect(report).toContain(
        "Exa: public mode without API Key (useApiKey: No)"
      );
      expect(report).not.toContain("API Key detected");
    });

    it("fully masks short keys", async () => {
      writeExaApiKey("abc123");
      const report = await buildWsStatusReport();
      expect(report).toContain("(••••••)");
      expect(report).not.toContain("abc123");
    });
  });

  describe("buildWsStatusReport: pi-requesty section", () => {
    it("reports nativeSearch disabled and no suppression by default", async () => {
      const report = await buildWsStatusReport();
      expect(report).toContain("pi-requesty:");
      expect(report).toContain("nativeSearch: disabled");
      expect(report).toContain("web_search: not suppressed");
    });

    it("reports nativeSearch enabled when pi-requesty.json has it", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const report = await buildWsStatusReport();
      expect(report).toContain("nativeSearch: enabled");
    });

    it("reports the suppression of web_search for a compatible Requesty model", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const report = await buildWsStatusReport({
        provider: "requesty",
        id: "gpt-4o",
        supportsWebSearch: true,
      });
      expect(report).toContain("web_search: suppressed");
      expect(report).toContain("(suppressed");
      expect(report).toContain("Requesty native search is active");
    });

    it("reports no suppression for Gemini models even with native search", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const report = await buildWsStatusReport({
        provider: "requesty",
        id: "gemini-2.0-pro",
        supportsWebSearch: true,
      });
      expect(report).toContain("web_search: not suppressed");
      expect(report).not.toContain("web_search: suppressed");
    });
  });

  describe("handleWsStatus", () => {
    it("delivers the full report as an info notification", async () => {
      const { ctx, notify } = mockCtx();
      await handleWsStatus(ctx);
      expect(notify).toHaveBeenCalledTimes(1);
      const [message, type] = notify.mock.calls[0] as [string, "info"];
      expect(type).toBe("info");
      expect(message).toContain("🌐 Web Search and Fetch — Current Status");
      expect(message).toContain("Tools:");
      expect(message).toContain("Credentials:");
      expect(message).toContain("pi-requesty:");
    });

    it("evaluates pi-requesty compatibility using ctx.model", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const { ctx, notify } = mockCtx({
        provider: "requesty",
        id: "gpt-4o",
        supportsWebSearch: true,
      });
      await handleWsStatus(ctx);
      const [message] = notify.mock.calls[0] as [string];
      expect(message).toContain("web_search: suppressed");
    });
  });
});
