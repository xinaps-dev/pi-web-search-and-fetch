import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_FILE_NAME,
  EXA_PROVIDER_KEY,
  getAuthFilePath,
  getExaApiKey,
  readStoredCredential,
  removeExaApiKey,
  writeExaApiKey,
} from "../src/config/auth.js";

describe("src/config/auth", () => {
  let tmpDir: string;
  const prevAgentDir = process.env.PI_AGENT_DIR;
  const prevExaKey = process.env.EXA_API_KEY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-and-fetch-auth-"));
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

  describe("readStoredCredential", () => {
    it("returns null when auth.json does not exist", () => {
      expect(readStoredCredential("exa")).toBeNull();
    });

    it("returns the stored api_key credential for a provider", () => {
      writeExaApiKey("exa-key-123");
      expect(readStoredCredential("exa")).toEqual({
        type: "api_key",
        key: "exa-key-123",
      });
    });

    it("returns null for a provider without a stored credential", () => {
      writeExaApiKey("exa-key-123");
      expect(readStoredCredential("tavily")).toBeNull();
    });

    it("returns null when auth.json is not valid JSON", () => {
      fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
      fs.writeFileSync(getAuthFilePath(), "{not json", "utf8");
      expect(readStoredCredential("exa")).toBeNull();
    });
  });

  describe("getExaApiKey", () => {
    it("returns null in public mode when useApiKey is false", () => {
      writeExaApiKey("stored-key");
      process.env.EXA_API_KEY = "env-key";
      expect(getExaApiKey(false)).toBeNull();
    });

    it("prefers the stored auth.json key over the environment variable", () => {
      writeExaApiKey("stored-key");
      process.env.EXA_API_KEY = "env-key";
      expect(getExaApiKey(true)).toBe("stored-key");
    });

    it("falls back to process.env.EXA_API_KEY when no key is stored", () => {
      process.env.EXA_API_KEY = "env-key";
      expect(getExaApiKey(true)).toBe("env-key");
    });

    it("returns null when neither stored key nor env var exists", () => {
      expect(getExaApiKey(true)).toBeNull();
    });
  });

  describe("writeExaApiKey", () => {
    it("saves the key in the standard format with 0o600 permissions", () => {
      writeExaApiKey("813a7c54-ee2b-42f4-a940-a9365d298728");

      const raw = JSON.parse(
        fs.readFileSync(getAuthFilePath(), "utf8")
      ) as Record<string, unknown>;
      expect(raw[EXA_PROVIDER_KEY]).toEqual({
        type: "api_key",
        key: "813a7c54-ee2b-42f4-a940-a9365d298728",
      });
      const mode = fs.statSync(getAuthFilePath()).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("creates the agent directory when it does not exist", () => {
      fs.rmSync(process.env.PI_AGENT_DIR as string, {
        recursive: true,
        force: true,
      });
      writeExaApiKey("fresh-key");
      expect(readStoredCredential("exa")).toEqual({
        type: "api_key",
        key: "fresh-key",
      });
    });

    it("preserves credentials of other providers", () => {
      fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
      fs.writeFileSync(
        getAuthFilePath(),
        JSON.stringify({
          other: { type: "api_key", key: "other-key" },
        })
      );
      writeExaApiKey("exa-key");

      const raw = JSON.parse(
        fs.readFileSync(getAuthFilePath(), "utf8")
      ) as Record<string, unknown>;
      expect(raw).toEqual({
        other: { type: "api_key", key: "other-key" },
        [EXA_PROVIDER_KEY]: { type: "api_key", key: "exa-key" },
      });
    });

    it("overwrites a previously stored Exa key", () => {
      writeExaApiKey("old-key");
      writeExaApiKey("new-key");
      expect(readStoredCredential("exa")).toEqual({
        type: "api_key",
        key: "new-key",
      });
    });
  });

  describe("removeExaApiKey", () => {
    it("removes the exa credential and preserves other providers", () => {
      fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
      fs.writeFileSync(
        getAuthFilePath(),
        JSON.stringify({
          other: { type: "api_key", key: "other-key" },
        })
      );
      writeExaApiKey("exa-key");
      removeExaApiKey();

      const raw = JSON.parse(
        fs.readFileSync(getAuthFilePath(), "utf8")
      ) as Record<string, unknown>;
      expect(raw).toEqual({
        other: { type: "api_key", key: "other-key" },
      });
      expect(readStoredCredential("exa")).toBeNull();
    });

    it("is a no-op when auth.json does not exist", () => {
      expect(() => removeExaApiKey()).not.toThrow();
      expect(fs.existsSync(getAuthFilePath())).toBe(false);
    });

    it("is a no-op when no exa credential is stored", () => {
      fs.mkdirSync(process.env.PI_AGENT_DIR as string, { recursive: true });
      fs.writeFileSync(
        getAuthFilePath(),
        JSON.stringify({ other: { type: "api_key", key: "other-key" } })
      );
      removeExaApiKey();
      expect(readStoredCredential("exa")).toBeNull();
    });
  });

  it("points the auth file at auth.json inside the agent directory", () => {
    expect(AUTH_FILE_NAME).toBe("auth.json");
    expect(getAuthFilePath()).toBe(
      path.join(process.env.PI_AGENT_DIR as string, AUTH_FILE_NAME)
    );
  });
});
