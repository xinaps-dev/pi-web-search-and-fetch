/**
 * Credential management for pi-web-scout.
 *
 * API keys are stored in the standard Pi credential store
 * `~/.pi/agent/auth.json` under the provider key (e.g. `"exa"`) with the
 * standard format `{ "type": "api_key", "key": "..." }`, so the extension
 * stays interoperable with other Pi extensions (e.g. `pi-exa`).
 *
 * Exa API key resolution hierarchy:
 * 1. `useApiKey: false` in the extension config → public free mode (no key).
 * 2. Otherwise `auth.json["exa"].key`.
 * 3. Otherwise the `EXA_API_KEY` environment variable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** File name of the standard Pi credential store. */
export const AUTH_FILE_NAME = "auth.json";

/** Provider key used in `auth.json` for Exa credentials. */
export const EXA_PROVIDER_KEY = "exa";

/** Standard credential entry stored in `auth.json`. */
export interface StoredCredential {
  /** Credential kind; API keys are the only kind used by pi-web-scout. */
  type: "api_key";
  /** The secret key value. */
  key: string;
}

/**
 * Agent directory holding `pi-web-scout.json` and `auth.json`
 * (`~/.pi/agent`). Overridable via `PI_AGENT_DIR` for tests.
 */
export function getAgentDir(): string {
  return (
    process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent")
  );
}

/** Full path of the standard credential store. */
export function getAuthFilePath(): string {
  return path.join(getAgentDir(), AUTH_FILE_NAME);
}

/**
 * Read the whole credential store. Returns `null` (fallback) when the file
 * does not exist, is not valid JSON or is not a JSON object.
 */
function readAuthStore(): Record<string, StoredCredential> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(getAuthFilePath(), "utf8");
  } catch {
    return null;
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }
    return data as Record<string, StoredCredential>;
  } catch {
    return null;
  }
}

/**
 * Read the stored credential for a provider from `auth.json`.
 * Returns `null` when the provider has no stored credential or
 * the credential store is missing/unreadable.
 */
export function readStoredCredential(
  provider: string
): StoredCredential | null {
  const store = readAuthStore();
  const credential = store?.[provider];
  if (
    credential === undefined ||
    typeof credential !== "object" ||
    credential === null ||
    typeof credential.key !== "string" ||
    credential.key === ""
  ) {
    return null;
  }
  return credential;
}

/**
 * Resolve the Exa API key:
 * - `useApiKeyRequested === false` → `null` (public free mode, no key).
 * - Otherwise `auth.json["exa"].key`, then `process.env.EXA_API_KEY`.
 *
 * Returns `null` when no key is available.
 */
export function getExaApiKey(useApiKeyRequested: boolean): string | null {
  if (!useApiKeyRequested) {
    return null;
  }
  const stored = readStoredCredential(EXA_PROVIDER_KEY);
  if (stored) {
    return stored.key;
  }
  return process.env.EXA_API_KEY || null;
}

/**
 * Persist the credential store to `auth.json` with secure `0o600`
 * permissions, creating the agent directory when needed.
 */
function writeAuthStore(store: Record<string, StoredCredential>): void {
  const agentDir = getAgentDir();
  fs.mkdirSync(agentDir, { recursive: true });
  const filePath = getAuthFilePath();
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.chmodSync(filePath, 0o600);
}

/**
 * Save the Exa API key to `auth.json` under the standard format
 * `{ "exa": { "type": "api_key", "key": "..." } }` with `0o600`
 * permissions, preserving credentials of other providers.
 */
export function writeExaApiKey(key: string): void {
  const store = readAuthStore() ?? {};
  store[EXA_PROVIDER_KEY] = { type: "api_key", key };
  writeAuthStore(store);
}

/**
 * Remove the Exa credential from `auth.json`, preserving credentials of
 * other providers. No-op when the store or the Exa entry
 * does not exist.
 */
export function removeExaApiKey(): void {
  const store = readAuthStore();
  if (!store || store[EXA_PROVIDER_KEY] === undefined) {
    return;
  }
  delete store[EXA_PROVIDER_KEY];
  writeAuthStore(store);
}
