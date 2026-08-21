import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXA_PROVIDER_KEY,
  getAuthFilePath,
  readStoredCredential,
  writeExaApiKey,
} from "../src/config/auth.js";
import { getConfig } from "../src/config/index.js";
import {
  EXA_MODAL_INFO,
  createExaConfigModal,
  persistExaConfig,
  type ExaModalValues,
} from "../src/providers/exa/ui.js";

/** Identity mock theme: returns the text unchanged (plain-text asserts). */
function mockTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

/** Render a component to lines, stripping right padding. */
function renderLines(component: Component, width = 200): string {
  return component
    .render(width)
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

// Raw terminal sequences (see pi-tui keys.js).
const ESC = "\x1b";
const ENTER = "\r";
const SPACE = " ";

describe("src/providers/exa/ui", () => {
  let tmpDir: string;
  const prevAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-scout-exa-ui-"));
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

  describe("createExaConfigModal (initial state)", () => {
    it("initializes the toggle from the config (default true)", async () => {
      const form = await createExaConfigModal(mockTheme());
      expect(form.getValue("useApiKey")).toBe(true);
    });

    it("initializes the toggle from a persisted config", async () => {
      await persistExaConfig({ useApiKey: false, apiKey: "" });
      const form = await createExaConfigModal(mockTheme());
      expect(form.getValue("useApiKey")).toBe(false);
    });

    it("loads the current API key from auth.json", async () => {
      writeExaApiKey("stored-key-123");
      const form = await createExaConfigModal(mockTheme());
      expect(form.getValue("apiKey")).toBe("stored-key-123");
    });

    it("starts with an empty key when none is stored", async () => {
      const form = await createExaConfigModal(mockTheme());
      expect(form.getValue("apiKey")).toBe("");
    });

    it("renders the toggle, the masked key, info and hint line", async () => {
      writeExaApiKey("secret-key");
      const form = await createExaConfigModal(mockTheme());
      const out = renderLines(form);
      expect(out).toContain("[ Use API Key: Yes / No ]");
      expect(out).toContain("Exa API Key:");
      // Secret field is masked with bullets, never the raw key.
      expect(out).toContain("•••••••••");
      expect(out).not.toContain("secret-key");
      // Explanatory text about public mode vs private quota.
      for (const line of EXA_MODAL_INFO) {
        expect(out).toContain(line);
      }
      expect(out).toContain("Enter save");
    });
  });

  describe("persistExaConfig", () => {
    it("persists useApiKey=false and removes the stored key", async () => {
      writeExaApiKey("old-key");
      await persistExaConfig({ useApiKey: false, apiKey: "ignored" });
      const config = await getConfig();
      expect(config.providers.exa.useApiKey).toBe(false);
      expect(readStoredCredential(EXA_PROVIDER_KEY)).toBeNull();
    });

    it("persists useApiKey=true and writes the key with 0o600", async () => {
      await persistExaConfig({ useApiKey: true, apiKey: "  new-key-456  " });
      const config = await getConfig();
      expect(config.providers.exa.useApiKey).toBe(true);
      expect(readStoredCredential(EXA_PROVIDER_KEY)).toEqual({
        type: "api_key",
        key: "new-key-456",
      });
      const mode = fs.statSync(getAuthFilePath()).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("keeps the stored key when saving with useApiKey=true and empty key", async () => {
      writeExaApiKey("keep-me");
      await persistExaConfig({ useApiKey: true, apiKey: "" });
      const config = await getConfig();
      expect(config.providers.exa.useApiKey).toBe(true);
      expect(readStoredCredential(EXA_PROVIDER_KEY)?.key).toBe("keep-me");
    });
  });

  describe("submit and cancel callbacks", () => {
    it("persists on submit and then calls onSubmit with the values", async () => {
      let submitted: ExaModalValues | undefined;
      const form = await createExaConfigModal(mockTheme(), {
        onSubmit: (values) => {
          submitted = values;
        },
      });

      form.handleInput(SPACE); // toggle off
      form.handleInput(ENTER); // submit
      await vi.waitFor(() => {
        expect(submitted).toBeDefined();
      });

      expect(submitted).toEqual({ useApiKey: false, apiKey: "" });
      const config = await getConfig();
      expect(config.providers.exa.useApiKey).toBe(false);
    });

    it("persists a newly typed key on submit", async () => {
      let submitted: ExaModalValues | undefined;
      const form = await createExaConfigModal(mockTheme(), {
        onSubmit: (values) => {
          submitted = values;
        },
      });

      // Navigate to the key field and type a key.
      form.handleInput("\x1b[B"); // down
      for (const ch of "typed-key-789") form.handleInput(ch);
      form.handleInput(ENTER);
      await vi.waitFor(() => {
        expect(submitted).toBeDefined();
      });

      expect(submitted).toEqual({ useApiKey: true, apiKey: "typed-key-789" });
      expect(readStoredCredential(EXA_PROVIDER_KEY)?.key).toBe("typed-key-789");
    });

    it("cancel calls onCancel without persisting anything", async () => {
      let cancelled = false;
      const form = await createExaConfigModal(mockTheme(), {
        onCancel: () => {
          cancelled = true;
        },
      });

      form.handleInput(ESC);
      expect(cancelled).toBe(true);
      // No config or credential was created.
      const config = await getConfig();
      expect(config.providers.exa.useApiKey).toBe(true);
      expect(readStoredCredential(EXA_PROVIDER_KEY)).toBeNull();
    });
  });
});
