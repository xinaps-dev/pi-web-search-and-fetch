/**
 * Strict TypeScript types for the extension config file
 * `~/.pi/agent/pi-web-search-and-fetch.json`.
 *
 * This module is type-only: it defines the exact JSON structure of the
 * config, one strict sub-type per section, so every other subsystem
 * (config read/persist, providers, tools, commands, UI) shares one
 * spelling per concept.
 */

/**
 * Per-tool config section (`search`, `fetch`, `deepSearch`):
 * whether the tool is enabled and which provider id is assigned to it.
 */
export interface WsToolConfig {
  /** Whether the tool is active in the configuration. */
  enabled: boolean;
  /** Provider id assigned to the tool (e.g. `"exa"`). */
  provider: string;
}

/**
 * Provider-specific options for Exa:
 * `useApiKey: false` means public free mode without an API key.
 */
export interface ExaProviderConfig {
  /** Whether to resolve and use a stored Exa API key. */
  useApiKey: boolean;
}

/**
 * `providers` section: provider-specific options keyed by provider id.
 * Strict: only the known providers are typed.
 */
export interface ProvidersConfig {
  /** Exa-specific options. */
  exa: ExaProviderConfig;
}

/**
 * Root structure of `~/.pi/agent/pi-web-search-and-fetch.json`:
 *
 * ```json
 * {
 *   "search":     { "enabled": true,  "provider": "exa" },
 *   "fetch":     { "enabled": true,  "provider": "exa" },
 *   "deepSearch": { "enabled": false, "provider": "exa" },
 *   "providers": { "exa": { "useApiKey": true } }
 * }
 * ```
 */
export interface PiWebSearchAndFetchConfig {
  /** `web_search` tool config. */
  search: WsToolConfig;
  /** `web_fetch` tool config. */
  fetch: WsToolConfig;
  /** `web_deep_search` tool config. */
  deepSearch: WsToolConfig;
  /** Provider-specific options. */
  providers: ProvidersConfig;
}
