/**
 * Global constants of pi-web-search-and-fetch: config file name, default configuration
 * values and the tool identifiers exposed to the LLM.
 *
 * This module is value-level and must stay free of imports from other
 * subsystems so every other module can rely on it as the single source of
 * truth for these constants.
 */

import type { WsToolId } from "../types.js";

/** File name of the extension config: `~/.pi/agent/pi-web-search-and-fetch.json`. */
export const CONFIG_FILE_NAME = "pi-web-search-and-fetch.json";

/**
 * Default configuration values merged over the on-disk config:
 * `web_search` and `web_fetch` enabled by default with `exa`,
 * `web_deep_search` disabled by default, Exa using its own API key.
 */
export const DEFAULT_CONFIG = {
  search: { enabled: true, provider: "exa" },
  fetch: { enabled: true, provider: "exa" },
  deepSearch: { enabled: false, provider: "exa" },
  providers: { exa: { useApiKey: true } },
} as const;

/**
 * Identifiers of the tools exposed to the LLM,
 * keyed by the config section names (`search`, `fetch`, `deepSearch`).
 */
export const TOOL_IDS = {
  search: "web_search",
  fetch: "web_fetch",
  deepSearch: "web_deep_search",
} as const satisfies Record<string, WsToolId>;
