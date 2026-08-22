/**
 * `/ws` command router.
 *
 * `/ws` is the single entry point of the extension. Without arguments it
 * opens the interactive Hub / Dashboard TUI; with arguments it dispatches
 * to the text-mode subcommands:
 *
 * - `/ws status`                    → detailed status report.
 * - `/ws search on|off`             → enable/disable `web_search`.
 * - `/ws fetch on|off`              → enable/disable `web_fetch`.
 * - `/ws deep on|off`               → enable/disable `web_deep_search`.
 * - `/ws provider <tool> <id|none>` → assign a provider to a tool.
 * - `/ws provider`                  → interactive 3-step assignment wizard.
 * - `/ws config [providerId]`       → open the provider configuration modal.
 * - `/ws help`                      → usage help.
 *
 * Unknown subcommands show an error with the usage summary. Every mutating
 * subcommand persists the change and immediately re-synchronizes the
 * active tools so the next turn sees the updated tool set.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { TOOL_IDS } from "../config/constants.js";
import { getConfig, updateConfig } from "../config/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { WsToolId, WsToolKey } from "../types.js";
import { syncActiveTools } from "../tools/sync.js";
import { handleWsHub } from "./hub.js";
import { launchProviderConfigModal, runProviderConfigSelector } from "./config.js";
import { handleWsStatus } from "./status.js";
import { runProviderSelector } from "../ui/selector.js";

/** Usage line for the command. */
export const WS_USAGE = "/ws";

/** Usage summary shown by `/ws help` and unknown-subcommand errors. */
export const WS_HELP_TEXT = [
  "Web Search and Fetch — usage:",
  "  /ws                            Open the interactive control hub",
  "  /ws status                     Show the detailed status report",
  "  /ws search on|off              Enable/disable web_search",
  "  /ws fetch on|off               Enable/disable web_fetch",
  "  /ws deep on|off                Enable/disable web_deep_search",
  "  /ws provider <tool> <id|none>  Assign a provider (tool: search|fetch|deep)",
  "  /ws provider                   Interactive provider assignment wizard",
  "  /ws config [providerId]        Configure a provider (e.g. Exa API key)",
  "  /ws help                       Show this help",
].join("\n");

/**
 * Config section key for each `WsToolKey` accepted by the router
 * (`search`, `fetch`, `deep`), with its LLM tool id and display label.
 */
const TOOL_KEYS: Record<
  WsToolKey,
  { section: "search" | "fetch" | "deepSearch"; toolId: WsToolId; label: string }
> = {
  search: { section: "search", toolId: TOOL_IDS.search, label: "web_search" },
  fetch: { section: "fetch", toolId: TOOL_IDS.fetch, label: "web_fetch" },
  deep: {
    section: "deepSearch",
    toolId: TOOL_IDS.deepSearch,
    label: "web_deep_search",
  },
};

/**
 * Parse a `WsToolKey` from a raw argument. Accepts the canonical keys plus
 * common aliases so the command stays forgiving at the CLI.
 */
function parseToolKey(raw: string): WsToolKey | undefined {
  const value = raw.toLowerCase();
  if (value === "search") {
    return "search";
  }
  if (value === "fetch") {
    return "fetch";
  }
  if (value === "deep" || value === "deepsearch" || value === "deep-search") {
    return "deep";
  }
  return undefined;
}

/**
 * Parse an on/off state argument.
 */
function parseState(raw: string): boolean | undefined {
  const value = raw.toLowerCase();
  if (value === "on" || value === "true" || value === "1") {
    return true;
  }
  if (value === "off" || value === "false" || value === "0") {
    return false;
  }
  return undefined;
}

/**
 * Handle `/ws <tool> <on|off>`: persist the toggle and re-sync tools.
 */
async function handleToggle(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  toolKey: WsToolKey,
  enabled: boolean
): Promise<void> {
  const meta = TOOL_KEYS[toolKey];
  await updateConfig({ [meta.section]: { enabled } });
  await syncActiveTools(pi, ctx.model);
  ctx.ui.notify(
    `${meta.label} ${enabled ? "enabled" : "disabled"}.`,
    "info"
  );
}

/**
 * Handle `/ws provider <tool> <id|none>`: assign a provider in text mode
 * (`none` disables the tool while keeping its provider id remembered).
 */
async function handleAssignProvider(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  registry: ProviderRegistry,
  toolKey: WsToolKey,
  providerArg: string
): Promise<void> {
  const meta = TOOL_KEYS[toolKey];
  const providerId = providerArg.toLowerCase();

  if (providerId !== "none" && registry.getProvider(providerId) === undefined) {
    const known = registry
      .getAllProviders()
      .map((m) => m.id)
      .join(", ");
    ctx.ui.notify(
      `Unknown provider "${providerArg}" for ${meta.label}.` +
        (known.length > 0 ? ` Registered providers: ${known}, none.` : ""),
      "error"
    );
    return;
  }

  // `none` disables the tool but keeps the current provider id so the
  // choice is remembered when the tool is re-enabled.
  const patch =
    providerId === "none"
      ? { enabled: false }
      : { enabled: true, provider: providerId };
  await updateConfig({ [meta.section]: patch });
  await syncActiveTools(pi, ctx.model);
  ctx.ui.notify(
    providerId === "none"
      ? `${meta.label} disabled (provider kept).`
      : `${meta.label} assigned to provider "${providerId}".`,
    "info"
  );
}

/**
 * Main `/ws` command handler: routes between the interactive Hub and the
 * text-mode subcommands described in the module header.
 *
 * @param ctx Command context (provides `ui.custom` / `ui.notify` /
 *   `ui.select` and the current model).
 * @param args Tokenized command arguments (empty for plain `/ws`).
 * @param registry Registry of the available provider modules.
 * @param pi Pi extension API; required by every subcommand because they
 *   all re-synchronize the active tools after mutating the config.
 */
export async function handleWsCommand(
  ctx: ExtensionCommandContext,
  args: string[],
  registry: ProviderRegistry,
  pi?: ExtensionAPI
): Promise<void> {
  if (args.length === 0) {
    if (pi === undefined) {
      ctx.ui.notify(
        `${WS_USAGE} — the interactive Hub requires Pi's TUI.`,
        "error"
      );
      return;
    }
    await handleWsHub(ctx, registry, pi);
    return;
  }

  if (pi === undefined) {
    ctx.ui.notify(
      `${WS_USAGE} — subcommands require Pi's TUI.`,
      "error"
    );
    return;
  }

  const [subcommand, ...rest] = args;

  switch (subcommand.toLowerCase()) {
    case "status":
      await handleWsStatus(ctx);
      return;

    case "help":
    case "--help":
    case "-h":
      ctx.ui.notify(WS_HELP_TEXT, "info");
      return;

    case "search":
    case "fetch":
    case "deep": {
      const toolKey = parseToolKey(subcommand)!;
      const state = rest[0] !== undefined ? parseState(rest[0]) : undefined;
      if (state === undefined) {
        ctx.ui.notify(
          `Usage: ${WS_USAGE} ${subcommand.toLowerCase()} on|off`,
          "error"
        );
        return;
      }
      await handleToggle(ctx, pi, toolKey, state);
      return;
    }

    case "provider": {
      const toolArg = rest[0];
      if (toolArg === undefined) {
        // No arguments: launch the interactive 3-step wizard.
        await runProviderSelector(ctx, registry, pi);
        return;
      }
      const toolKey = parseToolKey(toolArg);
      if (toolKey === undefined) {
        ctx.ui.notify(
          `Unknown tool "${toolArg}". Use search|fetch|deep.`,
          "error"
        );
        return;
      }
      const providerArg = rest[1];
      if (providerArg === undefined) {
        ctx.ui.notify(
          `Usage: ${WS_USAGE} provider ${toolArg} <id|none>`,
          "error"
        );
        return;
      }
      await handleAssignProvider(ctx, pi, registry, toolKey, providerArg);
      return;
    }

    case "config": {
      const providerArg = rest[0];
      if (providerArg === undefined) {
        await runProviderConfigSelector(ctx, registry);
        return;
      }
      await launchProviderConfigModal(ctx, registry, providerArg);
      return;
    }

    default:
      ctx.ui.notify(
        `Unknown subcommand "${subcommand}".\n\n${WS_HELP_TEXT}`,
        "error"
      );
      return;
  }
}
