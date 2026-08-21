/**
 * Provider configuration launcher (used by the /ws Hub).
 *
 * Dispatches provider configuration polymorphically via the provider module's
 * `configure(ctx)` method.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ProviderRegistry } from "../providers/registry.js";

/**
 * Open the configuration interface of a specific provider module.
 *
 * - Invokes `module.configure(ctx)` when implemented.
 * - Shows an info notification when the provider requires no configuration.
 * - Shows an error notification when the provider is unknown.
 *
 * @param ctx Command context (provides UI helpers).
 * @param registry Registry of the available provider modules.
 * @param providerId Provider id to configure.
 */
export async function launchProviderConfigModal(
  ctx: ExtensionCommandContext,
  registry: ProviderRegistry,
  providerId: string
): Promise<void> {
  const module = registry.getProvider(providerId);
  if (module === undefined) {
    ctx.ui.notify(`Unknown provider: "${providerId}".`, "error");
    return;
  }

  if (typeof module.configure !== "function") {
    ctx.ui.notify(
      `"${module.name}" does not require additional configuration.`,
      "info"
    );
    return;
  }

  await module.configure(ctx);
}

/**
 * Interactive selector to choose which provider to configure.
 *
 * - If no providers are registered: notifies an error.
 * - Always displays a selection menu of available providers (e.g. Exa, Tavily...)
 *   and launches the chosen provider's configuration.
 * - If cancelled (Escape / undefined), exits gracefully without launching anything.
 *
 * @param ctx Command context (provides `ui.select` / `ui.notify`).
 * @param registry Registry of the available provider modules.
 */
export async function runProviderConfigSelector(
  ctx: ExtensionCommandContext,
  registry: ProviderRegistry
): Promise<void> {
  const providers = registry.getAllProviders();
  if (providers.length === 0) {
    ctx.ui.notify("No providers are registered.", "error");
    return;
  }

  const options = providers.map((p) => p.name);
  const selectedName = await ctx.ui.select(
    "Select a provider to configure:",
    options
  );

  if (selectedName === undefined) {
    return;
  }

  const selected = providers.find((p) => p.name === selectedName);
  if (selected !== undefined) {
    await launchProviderConfigModal(ctx, registry, selected.id);
  }
}
