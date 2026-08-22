/**
 * Config read/persist functions for pi-web-search-and-fetch.
 *
 * The extension config lives at `~/.pi/agent/pi-web-search-and-fetch.json`.
 * `getConfig()` reads the on-disk config and merges it over the
 * built-in defaults so partial or missing files always yield a
 * complete `PiWebSearchAndFetchConfig`.
 * `updateConfig()` performs an atomic write (write-to-temp + rename)
 * so a crash never leaves a truncated config file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "./auth.js";
import { CONFIG_FILE_NAME, DEFAULT_CONFIG } from "./constants.js";
import type { PiWebSearchAndFetchConfig } from "./types.js";

/**
 * Full path of the extension config file
 * (`~/.pi/agent/pi-web-search-and-fetch.json`), overridable via `PI_AGENT_DIR`
 * for tests.
 */
export function getConfigPath(): string {
  return path.join(getAgentDir(), CONFIG_FILE_NAME);
}

/**
 * Deep-merge helper: merges `partial` over `base` for plain objects,
 * recursing one level per section. Used to merge on-disk values over
 * `DEFAULT_CONFIG` without mutating either input.
 */
function mergeConfig(
  base: PiWebSearchAndFetchConfig,
  partial: Partial<PiWebSearchAndFetchConfig>
): PiWebSearchAndFetchConfig {
  const result: PiWebSearchAndFetchConfig = {
    search: { ...base.search, ...(partial.search ?? {}) },
    fetch: { ...base.fetch, ...(partial.fetch ?? {}) },
    deepSearch: { ...base.deepSearch, ...(partial.deepSearch ?? {}) },
    providers: {
      exa: { ...base.providers.exa, ...(partial.providers?.exa ?? {}) },
    },
  };
  return result;
}

/**
 * Read `~/.pi/agent/pi-web-search-and-fetch.json` and merge it over the built-in
 * defaults. Returns a complete `PiWebSearchAndFetchConfig` even
 * when the file is missing, empty or partially populated.
 */
export async function getConfig(): Promise<PiWebSearchAndFetchConfig> {
  let raw: string;
  try {
    raw = fs.readFileSync(getConfigPath(), "utf8");
  } catch {
    // File missing or unreadable → pure defaults.
    return structuredClone(DEFAULT_CONFIG) as PiWebSearchAndFetchConfig;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON → pure defaults.
    return structuredClone(DEFAULT_CONFIG) as PiWebSearchAndFetchConfig;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return structuredClone(DEFAULT_CONFIG) as PiWebSearchAndFetchConfig;
  }

  return mergeConfig(
    structuredClone(DEFAULT_CONFIG) as PiWebSearchAndFetchConfig,
    parsed as Partial<PiWebSearchAndFetchConfig>
  );
}

/**
 * Persist the config atomically: write to a temp file in the same
 * directory, then rename over the target path.
 * Creates the agent directory when it does not yet exist.
 *
 * `partial` is merged over the current on-disk state (or defaults)
 * before writing, so callers can update a single section without
 * providing the full config.
 */
export async function updateConfig(
  partial: Partial<PiWebSearchAndFetchConfig>
): Promise<PiWebSearchAndFetchConfig> {
  const current = await getConfig();
  const merged = mergeConfig(current, partial);

  const agentDir = getAgentDir();
  fs.mkdirSync(agentDir, { recursive: true });

  const targetPath = getConfigPath();
  const tmpPath = path.join(
    agentDir,
    `.${CONFIG_FILE_NAME}.tmp-${process.pid}-${Date.now()}`
  );

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    // Clean up temp file on failure.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw err;
  }

  return merged;
}
