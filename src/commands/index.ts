/**
 * `/ws` command router.
 *
 * Opens the interactive Hub / Dashboard TUI.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { ProviderRegistry } from "../providers/registry.js";
import { handleWsHub } from "./hub.js";

/** Usage line for the command. */
export const WS_USAGE = "/ws";

/**
 * Main `/ws` command handler: opens the interactive Hub / Dashboard TUI.
 *
 * @param ctx Command context (provides `ui.custom` / `ui.notify` and the current model).
 * @param _args CLI arguments (ignored since `/ws` is the single interactive command).
 * @param registry Registry of the available provider modules.
 * @param pi Optional Pi extension API, required for the interactive Hub.
 */
export async function handleWsCommand(
  ctx: ExtensionCommandContext,
  _args: string[],
  registry: ProviderRegistry,
  pi?: ExtensionAPI
): Promise<void> {
  if (pi === undefined) {
    ctx.ui.notify(
      `${WS_USAGE} — the interactive Hub requires Pi's TUI.`,
      "error"
    );
    return;
  }
  await handleWsHub(ctx, registry, pi);
}
