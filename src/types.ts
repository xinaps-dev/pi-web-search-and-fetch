/**
 * Global common types, states and enumerations shared by every
 * pi-web-scout subsystem (config, providers, tools, commands, UI and
 * integrations).
 *
 * This module is intentionally type-only and independent of any provider,
 * config file or Pi runtime module, so all subsystems share one spelling
 * per concept.
 */

/** Identifiers of the tools exposed to the LLM. */
export type WsToolId = "web_search" | "web_fetch" | "web_deep_search";

/** Short tool names used in `/ws provider <tool> <id|none>` assignments. */
export type WsToolKey = "search" | "fetch" | "deep";

/** State values accepted by `/ws <tool> [on|off]` commands. */
export type ToolState = "on" | "off";

/** Subcommands of the central `/ws` command. */
export type WsSubcommand =
  | "status"
  | "search"
  | "fetch"
  | "deep"
  | "provider"
  | "config"
  | "help"
  | "hub";

/**
 * Result of evaluating whether `web_search` must be suppressed because of
 * the `pi-requesty` integration.
 */
export interface WebSearchSuppression {
  shouldSuppress: boolean;
  reason?: string;
}

/**
 * Snapshot of one tool's state as displayed by `/ws status` and the
 * interactive hub.
 */
export interface ToolStatus {
  toolId: WsToolId;
  enabled: boolean;
  /** Provider currently assigned to the tool. */
  providerId: string;
  /** True when the tool is temporarily disabled by an external integration. */
  suppressed?: boolean;
  /** Human-readable explanation when `suppressed` is true. */
  reason?: string;
}
