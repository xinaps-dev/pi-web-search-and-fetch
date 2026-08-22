import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_FILE_NAME,
  EXA_PROVIDER_KEY,
  getAgentDir,
  getAuthFilePath,
  getExaApiKey,
  readStoredCredential,
  removeExaApiKey,
  writeExaApiKey,
} from "../src/config/auth.js";
import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  TOOL_IDS,
} from "../src/config/constants.js";
import {
  getConfig,
  getConfigPath,
  updateConfig,
} from "../src/config/index.js";
import type { PiWebSearchAndFetchConfig } from "../src/config/types.js";

describe("tests/config.test.ts - Configuration and Credentials Management", () => {
  let tmpDir: string;
  const prevAgentDir = process.env.PI_AGENT_DIR;
  const prevExaKey = process.env.EXA_API_KEY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-config-test-"));
    process.env.PI_AGENT_DIR = tmpDir;
    delete process.env.EXA_API_KEY;
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

  describe("Constants and Paths", () => {
    it("exports the expected default configuration structure", () => {
      expect(CONFIG_FILE_NAME).toBe("pi-web-search-and-fetch.json");
      expect(AUTH_FILE_NAME).toBe("auth.json");
      expect(EXA_PROVIDER_KEY).toBe("exa");

      expect(DEFAULT_CONFIG).toEqual({
        search: { enabled: true, provider: "exa" },
        fetch: { enabled: true, provider: "exa" },
        deepSearch: { enabled: false, provider: "exa" },
        providers: { exa: { useApiKey: true } },
      });

      expect(TOOL_IDS).toEqual({
        search: "web_search",
        fetch: "web_fetch",
        deepSearch: "web_deep_search",
      });
    });

    it("resolves the agent directory using PI_AGENT_DIR override or default path", () => {
      expect(getAgentDir()).toBe(tmpDir);
      expect(getConfigPath()).toBe(path.join(tmpDir, "pi-web-search-and-fetch.json"));
      expect(getAuthFilePath()).toBe(path.join(tmpDir, "auth.json"));

      delete process.env.PI_AGENT_DIR;
      expect(getAgentDir()).toBe(path.join(os.homedir(), ".pi", "agent"));
      expect(getConfigPath()).toBe(
        path.join(os.homedir(), ".pi", "agent", "pi-web-search-and-fetch.json")
      );
      expect(getAuthFilePath()).toBe(
        path.join(os.homedir(), ".pi", "agent", "auth.json")
      );
      process.env.PI_AGENT_DIR = tmpDir;
    });
  });

  describe("Extension Configuration (pi-web-search-and-fetch.json)", () => {
    describe("Reading Configuration (getConfig)", () => {
      it("returns default configuration when pi-web-search-and-fetch.json does not exist", async () => {
        const config = await getConfig();
        expect(config).toEqual(DEFAULT_CONFIG);
        // Ensure returning a fresh cloned copy without mutations
        expect(config).not.toBe(DEFAULT_CONFIG);
      });

      it("returns default configuration when pi-web-search-and-fetch.json is empty", async () => {
        fs.writeFileSync(getConfigPath(), "", "utf8");
        const config = await getConfig();
        expect(config).toEqual(DEFAULT_CONFIG);
      });

      it("returns default configuration when pi-web-search-and-fetch.json contains invalid JSON", async () => {
        fs.writeFileSync(getConfigPath(), "{ invalid: json", "utf8");
        const config = await getConfig();
        expect(config).toEqual(DEFAULT_CONFIG);
      });

      it("returns default configuration when pi-web-search-and-fetch.json is not an object (primitive or array)", async () => {
        fs.writeFileSync(getConfigPath(), JSON.stringify([1, 2, 3]), "utf8");
        expect(await getConfig()).toEqual(DEFAULT_CONFIG);

        fs.writeFileSync(getConfigPath(), JSON.stringify("string-val"), "utf8");
        expect(await getConfig()).toEqual(DEFAULT_CONFIG);

        fs.writeFileSync(getConfigPath(), JSON.stringify(null), "utf8");
        expect(await getConfig()).toEqual(DEFAULT_CONFIG);
      });

      it("merges partial configuration on-disk preserving defaults for missing fields", async () => {
        const partial = {
          search: { enabled: false, provider: "custom-search" },
        };
        fs.writeFileSync(getConfigPath(), JSON.stringify(partial), "utf8");

        const config = await getConfig();
        expect(config.search).toEqual({
          enabled: false,
          provider: "custom-search",
        });
        expect(config.fetch).toEqual({ enabled: true, provider: "exa" });
        expect(config.deepSearch).toEqual({ enabled: false, provider: "exa" });
        expect(config.providers).toEqual({ exa: { useApiKey: true } });
      });

      it("merges nested partial provider configuration correctly", async () => {
        const partial = {
          providers: {
            exa: { useApiKey: false },
          },
        };
        fs.writeFileSync(getConfigPath(), JSON.stringify(partial), "utf8");

        const config = await getConfig();
        expect(config.providers.exa.useApiKey).toBe(false);
        expect(config.search.enabled).toBe(true);
        expect(config.fetch.enabled).toBe(true);
        expect(config.deepSearch.enabled).toBe(false);
      });

      it("loads a completely populated configuration file accurately", async () => {
        const fullConfig: PiWebSearchAndFetchConfig = {
          search: { enabled: false, provider: "brave" },
          fetch: { enabled: true, provider: "jina" },
          deepSearch: { enabled: true, provider: "exa" },
          providers: { exa: { useApiKey: false } },
        };
        fs.writeFileSync(getConfigPath(), JSON.stringify(fullConfig, null, 2), "utf8");

        const config = await getConfig();
        expect(config).toEqual(fullConfig);
      });
    });

    describe("Writing and Updating Configuration (updateConfig)", () => {
      it("creates the agent directory and writes default merged config on first update", async () => {
        const nestedDir = path.join(tmpDir, "nested", "agent");
        process.env.PI_AGENT_DIR = nestedDir;

        const updated = await updateConfig({
          search: { enabled: false, provider: "exa" },
        });

        expect(fs.existsSync(getConfigPath())).toBe(true);
        expect(updated.search.enabled).toBe(false);
        expect(updated.fetch.enabled).toBe(true);
        expect(updated.deepSearch.enabled).toBe(false);
        expect(updated.providers.exa.useApiKey).toBe(true);

        const onDisk = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
        expect(onDisk).toEqual(updated);
      });

      it("performs incremental partial updates without losing existing customized settings", async () => {
        await updateConfig({
          search: { enabled: false, provider: "exa" },
          providers: { exa: { useApiKey: false } },
        });

        // Second update toggles deepSearch only
        const secondUpdate = await updateConfig({
          deepSearch: { enabled: true, provider: "exa" },
        });

        expect(secondUpdate.search.enabled).toBe(false);
        expect(secondUpdate.providers.exa.useApiKey).toBe(false);
        expect(secondUpdate.deepSearch.enabled).toBe(true);
        expect(secondUpdate.fetch.enabled).toBe(true);

        const onDisk = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
        expect(onDisk).toEqual(secondUpdate);
      });

      it("formats the saved JSON with 2-space indentation", async () => {
        await updateConfig({ search: { enabled: true, provider: "exa" } });
        const raw = fs.readFileSync(getConfigPath(), "utf8");
        expect(raw).toContain('  "search": {\n    "enabled": true,');
        expect(raw.endsWith("\n")).toBe(true);
      });
    });
  });

  describe("Credentials Storage (auth.json)", () => {
    describe("Reading Credentials (readStoredCredential)", () => {
      it("returns null when auth.json does not exist", () => {
        expect(readStoredCredential("exa")).toBeNull();
      });

      it("returns null when auth.json is empty or contains malformed JSON", () => {
        fs.writeFileSync(getAuthFilePath(), "", "utf8");
        expect(readStoredCredential("exa")).toBeNull();

        fs.writeFileSync(getAuthFilePath(), "{ not-json", "utf8");
        expect(readStoredCredential("exa")).toBeNull();
      });

      it("returns null when auth.json is an array or primitive", () => {
        fs.writeFileSync(getAuthFilePath(), JSON.stringify(["item"]), "utf8");
        expect(readStoredCredential("exa")).toBeNull();

        fs.writeFileSync(getAuthFilePath(), JSON.stringify("text"), "utf8");
        expect(readStoredCredential("exa")).toBeNull();
      });

      it("returns the credential object when valid entry exists", () => {
        writeExaApiKey("test-key-12345");
        const cred = readStoredCredential("exa");
        expect(cred).toEqual({
          type: "api_key",
          key: "test-key-12345",
        });
      });

      it("returns null for nonexistent provider or invalid key structure", () => {
        writeExaApiKey("test-key");
        expect(readStoredCredential("tavily")).toBeNull();

        // Malformed provider entries
        fs.writeFileSync(
          getAuthFilePath(),
          JSON.stringify({
            exa: { type: "api_key", key: "" },
            emptyObj: {},
            nullEntry: null,
            numberKey: { type: "api_key", key: 123 },
          }),
          "utf8"
        );

        expect(readStoredCredential("exa")).toBeNull();
        expect(readStoredCredential("emptyObj")).toBeNull();
        expect(readStoredCredential("nullEntry")).toBeNull();
        expect(readStoredCredential("numberKey")).toBeNull();
      });
    });

    describe("Writing and Removing Credentials", () => {
      it("writes Exa API key with restrictive permissions (0o600)", () => {
        writeExaApiKey("813a7c54-ee2b-42f4-a940-a9365d298728");

        expect(fs.existsSync(getAuthFilePath())).toBe(true);
        const raw = JSON.parse(fs.readFileSync(getAuthFilePath(), "utf8"));
        expect(raw.exa).toEqual({
          type: "api_key",
          key: "813a7c54-ee2b-42f4-a940-a9365d298728",
        });

        const stat = fs.statSync(getAuthFilePath());
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);
      });

      it("creates parent directories recursively if missing when writing credentials", () => {
        const nestedDir = path.join(tmpDir, "nested", "agent-auth");
        process.env.PI_AGENT_DIR = nestedDir;

        writeExaApiKey("nested-key-val");
        expect(fs.existsSync(getAuthFilePath())).toBe(true);
        expect(readStoredCredential("exa")?.key).toBe("nested-key-val");
      });

      it("preserves other provider credentials in auth.json when writing Exa key", () => {
        const existingAuth = {
          openai: { type: "api_key", key: "sk-openai-123" },
          anthropic: { type: "api_key", key: "sk-ant-456" },
        };
        fs.writeFileSync(getAuthFilePath(), JSON.stringify(existingAuth, null, 2), "utf8");

        writeExaApiKey("exa-key-789");

        const raw = JSON.parse(fs.readFileSync(getAuthFilePath(), "utf8"));
        expect(raw.openai).toEqual({ type: "api_key", key: "sk-openai-123" });
        expect(raw.anthropic).toEqual({ type: "api_key", key: "sk-ant-456" });
        expect(raw.exa).toEqual({ type: "api_key", key: "exa-key-789" });
      });

      it("removes Exa API key while preserving other providers in auth.json", () => {
        const initialAuth = {
          openai: { type: "api_key", key: "sk-openai-123" },
          exa: { type: "api_key", key: "exa-key-to-delete" },
        };
        fs.writeFileSync(getAuthFilePath(), JSON.stringify(initialAuth, null, 2), "utf8");

        removeExaApiKey();
        expect(readStoredCredential("exa")).toBeNull();

        const raw = JSON.parse(fs.readFileSync(getAuthFilePath(), "utf8"));
        expect(raw.exa).toBeUndefined();
        expect(raw.openai).toEqual({ type: "api_key", key: "sk-openai-123" });

        const stat = fs.statSync(getAuthFilePath());
        expect(stat.mode & 0o777).toBe(0o600);
      });

      it("handles removeExaApiKey safely when auth.json does not exist or has no exa entry", () => {
        expect(() => removeExaApiKey()).not.toThrow();
        expect(fs.existsSync(getAuthFilePath())).toBe(false);

        writeExaApiKey("temp-key");
        expect(readStoredCredential("exa")?.key).toBe("temp-key");
        removeExaApiKey();
        expect(readStoredCredential("exa")).toBeNull();
        expect(() => removeExaApiKey()).not.toThrow();
      });
    });

    describe("API Key Resolution Hierarchy (getExaApiKey)", () => {
      it("returns null when useApiKey is false regardless of stored key or env var (Rule 1: public/free mode)", () => {
        writeExaApiKey("stored-key-123");
        process.env.EXA_API_KEY = "env-key-456";

        const resolved = getExaApiKey(false);
        expect(resolved).toBeNull();
      });

      it("prefers auth.json stored key over process.env.EXA_API_KEY when useApiKey is true (Rule 2a)", () => {
        writeExaApiKey("auth-stored-key");
        process.env.EXA_API_KEY = "env-var-key";

        const resolved = getExaApiKey(true);
        expect(resolved).toBe("auth-stored-key");
      });

      it("falls back to process.env.EXA_API_KEY when auth.json has no key and useApiKey is true (Rule 2b)", () => {
        process.env.EXA_API_KEY = "env-var-fallback-key";

        const resolved = getExaApiKey(true);
        expect(resolved).toBe("env-var-fallback-key");
      });

      it("returns null when neither auth.json nor environment variable is set and useApiKey is true", () => {
        delete process.env.EXA_API_KEY;
        const resolved = getExaApiKey(true);
        expect(resolved).toBeNull();
      });

      it("returns null when empty EXA_API_KEY is set in environment variable", () => {
        process.env.EXA_API_KEY = "";
        expect(getExaApiKey(true)).toBeNull();
      });
    });
  });

  describe("Integration: Config + Auth Interoperability", () => {
    it("correctly coordinates config settings with key resolution across full lifecycle", async () => {
      // 1. Initial default state: useApiKey is true, no keys present -> resolved is null
      let config = await getConfig();
      expect(config.providers.exa.useApiKey).toBe(true);
      expect(getExaApiKey(config.providers.exa.useApiKey)).toBeNull();

      // 2. User provides API key in auth.json
      writeExaApiKey("my-secret-exa-key");
      expect(getExaApiKey(config.providers.exa.useApiKey)).toBe("my-secret-exa-key");

      // 3. User switches to free mode via updateConfig
      config = await updateConfig({
        providers: { exa: { useApiKey: false } },
      });
      expect(config.providers.exa.useApiKey).toBe(false);
      // Key resolution must return null even though auth.json still contains the key
      expect(getExaApiKey(config.providers.exa.useApiKey)).toBeNull();
      expect(readStoredCredential("exa")?.key).toBe("my-secret-exa-key");

      // 4. User switches back to useApiKey: true
      config = await updateConfig({
        providers: { exa: { useApiKey: true } },
      });
      expect(getExaApiKey(config.providers.exa.useApiKey)).toBe("my-secret-exa-key");

      // 5. User removes API key from auth.json and sets env var
      removeExaApiKey();
      expect(getExaApiKey(config.providers.exa.useApiKey)).toBeNull();
      process.env.EXA_API_KEY = "env-provided-key";
      expect(getExaApiKey(config.providers.exa.useApiKey)).toBe("env-provided-key");
    });
  });
});
