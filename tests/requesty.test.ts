import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRequestyConfigPath,
  isGeminiModel,
  isRequestyNativeSearchEnabled,
  REQUESTY_CONFIG_FILE_NAME,
  REQUESTY_PROVIDER_ID,
  shouldSuppressWebSearch,
} from "../src/integrations/requesty.js";

function writeRequestyConfig(data: unknown): void {
  fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
  fs.writeFileSync(getRequestyConfigPath(), JSON.stringify(data), "utf8");
}

describe("tests/requesty.test.ts - Requesty Integration", () => {
  let tmpDir: string;
  const prevAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-requesty-"));
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

  describe("Constants and Path Resolution", () => {
    it("exports the expected constant names and provider identifier", () => {
      expect(REQUESTY_CONFIG_FILE_NAME).toBe("pi-requesty.json");
      expect(REQUESTY_PROVIDER_ID).toBe("requesty");
    });

    it("points to pi-requesty.json inside the agent directory", () => {
      expect(getRequestyConfigPath()).toBe(
        path.join(process.env.PI_AGENT_DIR as string, REQUESTY_CONFIG_FILE_NAME)
      );
    });

    it("resolves to ~/.pi/agent/pi-requesty.json by default or follows PI_AGENT_DIR", () => {
      const custom = path.join(tmpDir, "agent-home");
      const prev = process.env.PI_AGENT_DIR;
      process.env.PI_AGENT_DIR = custom;
      expect(getRequestyConfigPath()).toBe(
        path.join(custom, "pi-requesty.json")
      );
      process.env.PI_AGENT_DIR = prev;
    });
  });

  describe("Detection of pi-requesty.json & nativeSearch", () => {
    it("returns false when the config file does not exist", async () => {
      expect(await isRequestyNativeSearchEnabled()).toBe(false);
    });

    it("returns false when the config file is not valid JSON", async () => {
      fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
      fs.writeFileSync(getRequestyConfigPath(), "{invalid JSON payload", "utf8");
      expect(await isRequestyNativeSearchEnabled()).toBe(false);
    });

    it("returns false when the config file is an array or primitive", async () => {
      fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
      fs.writeFileSync(getRequestyConfigPath(), "[true]", "utf8");
      expect(await isRequestyNativeSearchEnabled()).toBe(false);

      fs.writeFileSync(getRequestyConfigPath(), '"nativeSearch"', "utf8");
      expect(await isRequestyNativeSearchEnabled()).toBe(false);

      fs.writeFileSync(getRequestyConfigPath(), "12345", "utf8");
      expect(await isRequestyNativeSearchEnabled()).toBe(false);
    });

    it("returns false when nativeSearch is missing from config object", async () => {
      writeRequestyConfig({ otherKey: "value" });
      expect(await isRequestyNativeSearchEnabled()).toBe(false);
    });

    it("returns false when nativeSearch is not strictly boolean true", async () => {
      writeRequestyConfig({ nativeSearch: "true" });
      expect(await isRequestyNativeSearchEnabled()).toBe(false);

      writeRequestyConfig({ nativeSearch: 1 });
      expect(await isRequestyNativeSearchEnabled()).toBe(false);

      writeRequestyConfig({ nativeSearch: false });
      expect(await isRequestyNativeSearchEnabled()).toBe(false);

      writeRequestyConfig({ nativeSearch: null });
      expect(await isRequestyNativeSearchEnabled()).toBe(false);
    });

    it("returns true when nativeSearch is strictly boolean true", async () => {
      writeRequestyConfig({ nativeSearch: true, otherSetting: "abc" });
      expect(await isRequestyNativeSearchEnabled()).toBe(true);
    });
  });

  describe("Gemini Model Detection", () => {
    it("detects Gemini model ids case-insensitively", () => {
      expect(isGeminiModel("gemini-2.0-pro")).toBe(true);
      expect(isGeminiModel("GEMINI-2.0-PRO")).toBe(true);
      expect(isGeminiModel("google/gemini-1.5-flash")).toBe(true);
      expect(isGeminiModel("requesty/gemini-2.5-flash")).toBe(true);
      expect(isGeminiModel("gemini-exp-1206")).toBe(true);
    });

    it("does not flag non-Gemini model ids", () => {
      expect(isGeminiModel("gpt-4o")).toBe(false);
      expect(isGeminiModel("claude-sonnet-4-5")).toBe(false);
      expect(isGeminiModel("grok-4")).toBe(false);
      expect(isGeminiModel("deepseek-r1")).toBe(false);
      expect(isGeminiModel("meta-llama/llama-3.3-70b-instruct")).toBe(false);
      expect(isGeminiModel("")).toBe(false);
    });
  });

  describe("Web Search Suppression Logic", () => {
    it("does not suppress when currentModel is not an object or is null/undefined", async () => {
      for (const value of [undefined, null, "requesty", 42, true, []]) {
        const result = await shouldSuppressWebSearch(value);
        expect(result.shouldSuppress).toBe(false);
        expect(result.reason).toBe("current model is not a Requesty model");
      }
    });

    it("does not suppress when the model has no provider property", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const result = await shouldSuppressWebSearch({ id: "gpt-4o", supportsWebSearch: true });
      expect(result.shouldSuppress).toBe(false);
      expect(result.reason).toBe("current model is not a Requesty model");
    });

    it("does not suppress when the provider is not requesty", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const result = await shouldSuppressWebSearch({
        provider: "openai",
        id: "gpt-4o",
        supportsWebSearch: true,
      });
      expect(result.shouldSuppress).toBe(false);
      expect(result.reason).toBe("current model provider is not requesty");
    });

    it("does not suppress when pi-requesty nativeSearch is disabled (false)", async () => {
      writeRequestyConfig({ nativeSearch: false });
      const result = await shouldSuppressWebSearch({
        provider: "requesty",
        id: "gpt-4o",
        supportsWebSearch: true,
      });
      expect(result.shouldSuppress).toBe(false);
      expect(result.reason).toBe("pi-requesty nativeSearch is disabled");
    });

    it("does not suppress when the pi-requesty config file is missing", async () => {
      const result = await shouldSuppressWebSearch({
        provider: "requesty",
        id: "gpt-4o",
        supportsWebSearch: true,
      });
      expect(result.shouldSuppress).toBe(false);
      expect(result.reason).toBe("pi-requesty nativeSearch is disabled");
    });

    it("does not suppress Gemini models even when supportsWebSearch and nativeSearch are true", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const result = await shouldSuppressWebSearch({
        provider: "requesty",
        id: "gemini-2.0-pro",
        supportsWebSearch: true,
      });
      expect(result.shouldSuppress).toBe(false);
      expect(result.reason).toMatch(/Gemini models do not support combining function calling/i);
    });

    it("does not suppress when supportsWebSearch is missing or not strictly true", async () => {
      writeRequestyConfig({ nativeSearch: true });
      for (const supportsWebSearch of [undefined, false, "true", 1, null]) {
        const result = await shouldSuppressWebSearch({
          provider: "requesty",
          id: "gpt-4o",
          supportsWebSearch,
        });
        expect(result.shouldSuppress).toBe(false);
        expect(result.reason).toBe("current model does not support native web search");
      }
    });

    it("suppresses web_search for a non-Gemini Requesty model with supportsWebSearch and nativeSearch enabled", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const result = await shouldSuppressWebSearch({
        provider: "requesty",
        id: "gpt-4o",
        supportsWebSearch: true,
      });
      expect(result.shouldSuppress).toBe(true);
      expect(result.reason).toContain("Requesty native search is active");
    });

    it("suppresses case-insensitively for the requesty provider", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const result = await shouldSuppressWebSearch({
        provider: "Requesty",
        id: "claude-3-7-sonnet",
        supportsWebSearch: true,
      });
      expect(result.shouldSuppress).toBe(true);
      expect(result.reason).toContain("Requesty native search is active");
    });

    it("suppresses when model has no id or empty id but has requesty provider and supportsWebSearch", async () => {
      writeRequestyConfig({ nativeSearch: true });
      const result = await shouldSuppressWebSearch({
        provider: "requesty",
        supportsWebSearch: true,
      });
      expect(result.shouldSuppress).toBe(true);
    });
  });
});
