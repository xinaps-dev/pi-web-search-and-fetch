/**
 * Dynamic synchronization of the active tools of pi-web-scout.
 *
 * `syncActiveTools` recomputes which of the extension tools
 * (`web_search`, `web_fetch`, `web_deep_search`) the LLM should see on the
 * next turn and applies that list through `pi.setActiveTools()`:
 *
 * - A tool is active when its section in `~/.pi/agent/pi-web-scout.json`
 *   has `enabled: true` (`search.enabled`, `fetch.enabled`,
 *   `deepSearch.enabled`).
 * - `web_search` is additionally suppressed when the `pi-requesty`
 *   integration requires it (Requesty `nativeSearch: true` + compatible
 *   non-Gemini model with `supportsWebSearch: true`), to avoid duplication
 *   with Requesty's native search.
 * - `web_fetch` is always kept active (when `fetch.enabled` is `true`):
 *   Requesty does not perform page navigation or full-content fetch, so
 *   there is never a conflict to avoid.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOL_IDS } from "../config/constants.js";
import { getConfig } from "../config/index.js";
import { shouldSuppressWebSearch } from "../integrations/requesty.js";

/**
 * Synchronize the active tools of pi-web-scout with the current extension
 * configuration and the current model.
 *
 * 1. Reads `~/.pi/agent/pi-web-scout.json` (merged over defaults) to
 *    evaluate `search.enabled`, `fetch.enabled` and `deepSearch.enabled`.
 * 2. Evaluates the `pi-requesty` suppression rules for `web_search`
 *    against `currentModel`.
 * 3. Merges the computed Scout tools with the tools already active in the
 *    session (non-scout tools such as Pi built-ins and other extensions'
 *    tools are preserved) and calls `pi.setActiveTools()` with the final
 *    list, Scout tools in the stable order `web_search`, `web_fetch`,
 *    `web_deep_search`.
 *
 * @param pi Pi extension API receiving `setActiveTools`.
 * @param currentModel Optional current model object; when omitted or not a
 *   compatible Requesty model, no suppression is applied.
 */
export async function syncActiveTools(
  pi: ExtensionAPI,
  currentModel?: unknown
): Promise<void> {
  const config = await getConfig();
  const suppression = await shouldSuppressWebSearch(currentModel);

  const activeTools: string[] = [];

  // web_search: active when enabled in config AND not suppressed by the
  // pi-requesty integration.
  if (config.search.enabled && !suppression.shouldSuppress) {
    activeTools.push(TOOL_IDS.search);
  }

  // web_fetch: always kept (when enabled in config); Requesty never fetches
  // full pages, so there is no suppression rule for it.
  if (config.fetch.enabled) {
    activeTools.push(TOOL_IDS.fetch);
  }

  // web_deep_search: optional, disabled by default.
  if (config.deepSearch.enabled) {
    activeTools.push(TOOL_IDS.deepSearch);
  }

  // Preserve tools that are active in the session but do not belong to
  // pi-web-scout (Pi built-ins and other extensions' tools); otherwise
  // `setActiveTools` would deactivate them for the whole agent session.
  const scoutToolNames = new Set<string>(Object.values(TOOL_IDS));
  const currentActive =
    typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
  const nonScoutTools = currentActive.filter(
    (id) => !scoutToolNames.has(id)
  );

  pi.setActiveTools([...nonScoutTools, ...activeTools]);
}
