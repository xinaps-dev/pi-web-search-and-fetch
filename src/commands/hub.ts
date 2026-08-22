/**
 * `/ws` (no arguments) command — opens the interactive Hub / Dashboard
 * TUI.
 *
 * When `/ws` is executed without arguments in interactive mode
 * (`ctx.hasUI`), this handler opens the Hub component
 * (`src/ui/hub-component.ts`) as a keyboard-focused overlay via
 * `ctx.ui.custom()`. The hub displays:
 *
 * - a visual summary of the state of the three tools and their active
 *   providers;
 * - a quick-action menu navigable with arrow keys and executed with
 *   `Enter`/`Space`:
 *   - **Assign Providers** → launches the 3-step provider selector
 *     wizard (`src/ui/selector.ts`);
 *   - **Configure Active Provider** → opens the active provider's
 *     configuration modal;
 *   - **View Detailed Status** → shows the full `/ws status` report;
 *   - **Exit** → closes the hub.
 *
 * The hub overlay closes before any action is performed, so the action
 * can open its own overlay or show a notification without conflict.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getConfig } from "../config/index.js";
import type { PiWebSearchAndFetchConfig } from "../config/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { shouldSuppressWebSearch } from "../integrations/requesty.js";
import {
  buildHubToolStatuses,
  createHubComponent,
  HUB_ACTION_IDS,
} from "../ui/hub-component.js";
import { runProviderSelector } from "../ui/selector.js";
import { runProviderConfigSelector } from "./config.js";
import { buildWsStatusReport } from "./status.js";

/**
 * Command handler for `/ws` without arguments:
 * opens the interactive Hub / Dashboard TUI.
 *
 * The hub is shown as a keyboard-focused `ctx.ui.custom()` overlay.
 * When the user selects a quick action (other than "exit"), the hub
 * closes first and then the action is performed:
 *
 * - `providers` → 3-step provider selector assistant;
 * - `configure` → modular provider configuration selector;
 * - `status` → detailed status report;
 * - `exit` → just closes the hub.
 *
 * @param ctx Command context (provides `ui.custom` / `ui.notify` /
 *   `ui.select` and the current model).
 * @param registry Registry of the available provider modules.
 * @param pi Pi extension API (required for the provider selector's tool
 *   sync).
 */
export async function handleWsHub(
  ctx: ExtensionCommandContext,
  registry: ProviderRegistry,
  pi: ExtensionAPI
): Promise<void> {
  const config = await getConfig();
  const suppression = await shouldSuppressWebSearch(ctx.model);
  const toolStatuses = buildHubToolStatuses(config, suppression);

  let selectedAction: string | null = null;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const hub = createHubComponent(
      { toolStatuses },
      theme,
      {
        onAction: (actionId) => {
          selectedAction = actionId;
          done(undefined);
        },
        onExit: () => done(undefined),
      }
    );
    return hub;
  });

  if (selectedAction === null || selectedAction === HUB_ACTION_IDS.exit) {
    return;
  }

  switch (selectedAction) {
    case HUB_ACTION_IDS.providers:
      await runProviderSelector(ctx, registry, pi);
      break;
    case HUB_ACTION_IDS.configure:
      await runProviderConfigSelector(ctx, registry);
      break;
    case HUB_ACTION_IDS.status:
      ctx.ui.notify(await buildWsStatusReport(ctx.model), "info");
      break;
  }
}
