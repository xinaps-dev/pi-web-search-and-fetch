/**
 * 3-step provider selector wizard.
 *
 * Launched by `/ws provider` (no arguments) or from the Hub TUI, the
 * wizard walks the user through three consecutive selection steps,
 * one per tool exposed to the LLM:
 *
 * 1. `web_search`      → search providers (capability `"search"`) + `none`.
 * 2. `web_fetch`       → fetch providers (capability `"fetch"`) + `none`.
 * 3. `web_deep_search` → deep-search providers (capability `"deep-search"`)
 *    + `none`.
 *
 * Each step is rendered with `ctx.ui.select`. Selecting a
 * provider enables the tool and assigns that provider; selecting `none`
 * disables the tool (its provider id is kept in the config so the choice
 * is remembered for when the tool is re-enabled).
 *
 * After the three steps the wizard persists the changes to
 * `~/.pi/agent/pi-web-search-and-fetch.json` (atomic write) and immediately
 * re-synchronizes the active tools (`syncActiveTools`) so the
 * next turn already sees the updated tool set. If the user cancels any
 * step, no change is applied.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { TOOL_IDS } from "../config/constants.js";
import { getConfig, updateConfig } from "../config/index.js";
import type { PiWebSearchAndFetchConfig } from "../config/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { WsToolId } from "../types.js";
import { syncActiveTools } from "../tools/sync.js";

/** Option label that disables the tool. */
export const NONE_PROVIDER = "none";

/** Config section keys of the three selectable tools, in step order. */
export type SelectorToolSection = "search" | "fetch" | "deepSearch";

/**
 * One selection step of the assistant: the tool it configures, its user-
 * facing label, the option labels shown in the dialog and the provider
 * id behind each option (`null` for the `none` option).
 */
export interface SelectorStep {
  /** Config section of the tool this step configures. */
  section: SelectorToolSection;
  /** Tool id exposed to the LLM (e.g. `web_search`). */
  toolId: WsToolId;
  /** Human-readable step label (e.g. "Search"). */
  label: string;
  /** Option labels shown in the selection dialog (providers + `none`). */
  options: string[];
  /** Provider id behind each option, same order as `options`. */
  providerIds: (string | null)[];
}

/** Result of one step: the chosen provider id, or `null` for `none`. */
export interface ProviderSelection {
  /** Config section of the configured tool. */
  section: SelectorToolSection;
  /** Tool id exposed to the LLM. */
  toolId: WsToolId;
  /** Chosen provider id, or `null` when `none` was selected. */
  providerId: string | null;
}

/** Outcome of a full selector run. */
export interface ProviderSelectionResult {
  /** True when the user cancelled a step (no changes were applied). */
  cancelled: boolean;
  /** One entry per completed step (empty when cancelled). */
  selections: ProviderSelection[];
}

/**
 * Build the three selector steps from the registry:
 * step 1 lists the `search` providers, step 2 the `fetch` providers and
 * step 3 the `deep-search` providers, each followed by the `none` option.
 */
export function buildProviderSelectorSteps(
  registry: ProviderRegistry
): SelectorStep[] {
  const searchProviders = registry.getSearchProviders();
  const fetchProviders = registry.getFetchProviders();
  const deepSearchProviders = registry.getDeepSearchProviders();

  return [
    {
      section: "search",
      toolId: TOOL_IDS.search,
      label: "Search",
      options: buildOptions(searchProviders),
      providerIds: buildProviderIds(searchProviders),
    },
    {
      section: "fetch",
      toolId: TOOL_IDS.fetch,
      label: "Fetch",
      options: buildOptions(fetchProviders),
      providerIds: buildProviderIds(fetchProviders),
    },
    {
      section: "deepSearch",
      toolId: TOOL_IDS.deepSearch,
      label: "Deep Search",
      options: buildOptions(deepSearchProviders),
      providerIds: buildProviderIds(deepSearchProviders),
    },
  ];
}

/**
 * Run the 3-step provider selector wizard.
 *
 * Prompts one `ctx.ui.select` dialog per tool, persists the collected
 * selections to `pi-web-search-and-fetch.json` (atomic write) and immediately
 * re-synchronizes the active tools via `syncActiveTools`.
 *
 * @param ctx Command context providing `ui.select` / `ui.notify` and the
 *  current model (used for the `pi-requesty` suppression evaluation).
 * @param registry Registry of the available provider modules.
 * @param pi Extension API receiving `setActiveTools` on sync.
 * @returns The collected selections, or `cancelled: true` when the user
 *  cancelled a step (in which case nothing was persisted).
 */
export async function runProviderSelector(
  ctx: ExtensionCommandContext,
  registry: ProviderRegistry,
  pi: ExtensionAPI
): Promise<ProviderSelectionResult> {
  const steps = buildProviderSelectorSteps(registry);
  const selections: ProviderSelection[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const title = `Step ${i + 1}/${steps.length} · ${step.label} (${step.toolId})`;
    const selected = await ctx.ui.select(title, step.options);

    if (selected === undefined) {
      ctx.ui.notify(
        "Provider wizard cancelled; no changes were applied."
      );
      return { cancelled: true, selections: [] };
    }

    const index = step.options.indexOf(selected);
    selections.push({
      section: step.section,
      toolId: step.toolId,
      providerId:
        index >= 0 ? (step.providerIds[index] ?? null) : null,
    });
  }

  await applySelections(selections);
  await syncActiveTools(pi, ctx.model);

  ctx.ui.notify(
    [
      "Applied providers:",
      ...selections.map(
        (s) =>
          `  ${s.toolId}: ${s.providerId === null ? "none (disabled)" : s.providerId}`
      ),
    ].join("\n")
  );

  return { cancelled: false, selections };
}

/**
 * Persist the collected selections to `pi-web-search-and-fetch.json`:
 * a chosen provider enables the tool and assigns the provider; `none`
 * disables the tool while keeping its current provider id.
 */
async function applySelections(
  selections: ProviderSelection[]
): Promise<PiWebSearchAndFetchConfig> {
  const config = await getConfig();
  const partial: Partial<PiWebSearchAndFetchConfig> = {};

  for (const selection of selections) {
    const current = config[selection.section];
    if (selection.providerId === null) {
      partial[selection.section] = {
        enabled: false,
        provider: current.provider,
      };
    } else {
      partial[selection.section] = {
        enabled: true,
        provider: selection.providerId,
      };
    }
  }

  return updateConfig(partial);
}

/**
 * Option labels for a step: each provider's display name followed by the
 * `none` option. The display name is the provider `name`,
 * falling back to the `id` when two providers would otherwise collide.
 */
function buildOptions(
  providers: { id: string; name: string }[]
): string[] {
  const options: string[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    let label = provider.name;
    if (seen.has(label)) {
      label = provider.id;
    }
    seen.add(label);
    options.push(label);
  }
  options.push(NONE_PROVIDER);
  return options;
}

/**
 * Provider id behind each option position: one id per provider in the
 * same order as the options, with `null` for the trailing `none` option.
 */
function buildProviderIds(
  providers: { id: string; name: string }[]
): (string | null)[] {
  return [...providers.map((provider) => provider.id), null];
}
