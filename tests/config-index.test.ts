import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getConfig,
  getConfigPath,
  updateConfig,
} from "../src/config/index.js";
import { CONFIG_FILE_NAME, DEFAULT_CONFIG } from "../src/config/constants.js";
import type { PiWebSearchAndFetchConfig } from "../src/config/types.js";

describe("src/config/index", () => {
  let tmpDir: string;
  const prevAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-config-"));
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

  describe("getConfigPath", () => {
    it("returns the path to pi-web-search-and-fetch.json inside the agent directory", () => {
      expect(getConfigPath()).toBe(
        path.join(process.env.PI_AGENT_DIR as string, CONFIG_FILE_NAME)
      );
    });

    it("uses the PI_AGENT_DIR override", () => {
      const custom = path.join(tmpDir, "custom-agent");
      process.env.PI_AGENT_DIR = custom;
      expect(getConfigPath()).toBe(path.join(custom, CONFIG_FILE_NAME));
    });
  });

  describe("getConfig", () => {
    it("returns pure defaults when the config file does not exist", async () => {
      const config = await getConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it("returns pure defaults when the config file is empty", async () => {
      fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
      fs.writeFileSync(getConfigPath(), "", "utf8");
      const config = await getConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it("returns pure defaults when the config file is not valid JSON", async () => {
      fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
      fs.writeFileSync(getConfigPath(), "{not valid json", "utf8");
      const config = await getConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it("returns pure defaults when the config file is not an object", async () => {
      fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
      fs.writeFileSync(getConfigPath(), "[1,2,3]", "utf8");
      const config = await getConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it("merges a partial on-disk config over defaults", async () => {
      fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
      const partial = {
        search: { enabled: false, provider: "tavily" },
      };
      fs.writeFileSync(getConfigPath(), JSON.stringify(partial), "utf8");

      const config = await getConfig();
      expect(config.search).toEqual({ enabled: false, provider: "tavily" });
      // Untouched sections keep defaults.
      expect(config.fetch).toEqual({ enabled: true, provider: "exa" });
      expect(config.deepSearch).toEqual({ enabled: false, provider: "exa" });
      expect(config.providers).toEqual({ exa: { useApiKey: true } });
    });

    it("merges a full on-disk config", async () => {
      fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
      const full: PiWebSearchAndFetchConfig = {
        search: { enabled: false, provider: "brave" },
        fetch: { enabled: true, provider: "jina" },
        deepSearch: { enabled: true, provider: "exa" },
        providers: { exa: { useApiKey: false } },
      };
      fs.writeFileSync(getConfigPath(), JSON.stringify(full), "utf8");

      const config = await getConfig();
      expect(config).toEqual(full);
    });

    it("merges individual fields within a section", async () => {
      fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
      const partial = {
        search: { enabled: false },
      };
      fs.writeFileSync(getConfigPath(), JSON.stringify(partial), "utf8");

      const config = await getConfig();
      expect(config.search).toEqual({ enabled: false, provider: "exa" });
    });
  });

  describe("updateConfig", () => {
    it("creates the config file with defaults merged with the partial", async () => {
      const result = await updateConfig({
        search: { enabled: false, provider: "exa" },
      });

      expect(result).toEqual({
        search: { enabled: false, provider: "exa" },
        fetch: { enabled: true, provider: "exa" },
        deepSearch: { enabled: false, provider: "exa" },
        providers: { exa: { useApiKey: true } },
      });

      // Verify the file was written.
      const raw = JSON.parse(
        fs.readFileSync(getConfigPath(), "utf8")
      ) as PiWebSearchAndFetchConfig;
      expect(raw).toEqual(result);
    });

    it("creates the agent directory when it does not exist", async () => {
      fs.rmSync(process.env.PI_AGENT_DIR as string, {
        recursive: true,
        force: true,
      });
      await updateConfig({ fetch: { enabled: false, provider: "exa" } });
      expect(fs.existsSync(getConfigPath())).toBe(true);
    });

    it("merges over an existing on-disk config", async () => {
      // Seed an existing config.
      fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
      const existing: PiWebSearchAndFetchConfig = {
        search: { enabled: true, provider: "exa" },
        fetch: { enabled: true, provider: "exa" },
        deepSearch: { enabled: true, provider: "exa" },
        providers: { exa: { useApiKey: false } },
      };
      fs.writeFileSync(getConfigPath(), JSON.stringify(existing), "utf8");

      // Update only the search section.
      const result = await updateConfig({
        search: { enabled: false, provider: "tavily" },
      });

      expect(result.search).toEqual({ enabled: false, provider: "tavily" });
      // Untouched sections preserved.
      expect(result.fetch).toEqual({ enabled: true, provider: "exa" });
      expect(result.deepSearch).toEqual({ enabled: true, provider: "exa" });
      expect(result.providers).toEqual({ exa: { useApiKey: false } });
    });

    it("writes valid JSON with a trailing newline", async () => {
      await updateConfig({ deepSearch: { enabled: true, provider: "exa" } });
      const raw = fs.readFileSync(getConfigPath(), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it("is atomic: no temp file remains after success", async () => {
      await updateConfig({ fetch: { enabled: false, provider: "exa" } });
      const dirEntries = fs.readdirSync(process.env.PI_AGENT_DIR as string);
      const tmpFiles = dirEntries.filter((f) => f.includes(".tmp-"));
      expect(tmpFiles).toHaveLength(0);
    });

    it("preserves prior state when re-reading after a successful write", async () => {
      // Write a valid config.
      await updateConfig({ search: { enabled: true, provider: "exa" } });
      const before = fs.readFileSync(getConfigPath(), "utf8");

      // Re-reading yields the same data.
      const after = await getConfig();
      expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8"))).toEqual(
        JSON.parse(before)
      );
      expect(after).toEqual(JSON.parse(before));
    });
  });

  describe("integration: getConfig after updateConfig", () => {
    it("round-trips a config update", async () => {
      const updated = await updateConfig({
        search: { enabled: false, provider: "brave" },
        providers: { exa: { useApiKey: false } },
      });

      const reloaded = await getConfig();
      expect(reloaded).toEqual(updated);
    });

    it("preserves all sections across successive updates", async () => {
      await updateConfig({ search: { enabled: false, provider: "exa" } });
      await updateConfig({ fetch: { enabled: false, provider: "exa" } });
      await updateConfig({ deepSearch: { enabled: true, provider: "exa" } });

      const config = await getConfig();
      expect(config.search).toEqual({ enabled: false, provider: "exa" });
      expect(config.fetch).toEqual({ enabled: false, provider: "exa" });
      expect(config.deepSearch).toEqual({ enabled: true, provider: "exa" });
      expect(config.providers).toEqual({ exa: { useApiKey: true } });
    });
  });
});
