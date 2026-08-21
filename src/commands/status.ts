/**
 * `/ws status` command.
 *
 * Shows the complete current state of the extension as a formatted
 * notification (`ctx.ui.notify`):
 *
 * - state of the three tools (`web_search`, `web_fetch`,
 *   `web_deep_search`) with their assigned providers, in the same
 *   `ToolStatus` snapshot format used by the interactive hub
 *   (`src/ui/hub-component.ts`);
 * - detected Exa API key: its source (`auth.json` vs
 *   `EXA_API_KEY` environment variable) with a masked value, or the
 *   public free mode when no key is used;
 * - `pi-requesty` compatibility state: the `nativeSearch` flag and
 *   whether `web_search` is suppressed for the current model.
 *
 * The report is built by {@link buildWsStatusReport} (pure data
 * formatting, reusable by the hub's "Ver Estado Detallado" action)
 * and delivered by {@link handleWsStatus}, the command handler wired
 * to the `/ws` router.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { EXA_PROVIDER_KEY, getExaApiKey, readStoredCredential } from "../config/auth.js";
import { TOOL_IDS } from "../config/constants.js";
import { getConfig } from "../config/index.js";
import {
  isRequestyNativeSearchEnabled,
  shouldSuppressWebSearch,
} from "../integrations/requesty.js";
import type { ToolStatus, WsToolId } from "../types.js";
import { buildHubToolStatuses } from "../ui/hub-component.js";

/**
 * User-facing labels of the three tools, matching the hub display.
 */
const TOOL_LABELS: Record<WsToolId, string> = {
  [TOOL_IDS.search]: "Search (web_search)",
  [TOOL_IDS.fetch]: "Fetch (web_fetch)",
  [TOOL_IDS.deepSearch]: "Deep Search (web_deep_search)",
};

/**
 * Mask an API key for display: keeps the first 4 and last 4 characters
 * and hides everything in between. Short keys are fully masked.
 */
function maskKey(key: string): string {
  if (key.length <= 8) {
    return "•".repeat(key.length);
  }
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

/**
 * Render one tool state line of the status report:
 * `[✓] Search (web_search) : ON (Provider: exa)`, with a
 * suppression note when the `pi-requesty` integration suppresses the
 * tool.
 */
function renderToolLine(status: ToolStatus): string {
  const label = TOOL_LABELS[status.toolId] ?? status.toolId;
  const box = status.enabled ? "[✓]" : "[ ]";
  const state = status.enabled ? "ON" : "OFF";
  let line = `  ${box} ${label} : ${state} (Provider: ${status.providerId})`;
  if (status.suppressed) {
    const reason = status.reason !== undefined ? `: ${status.reason}` : "";
    line += ` (suppressed${reason})`;
  }
  return line;
}

/**
 * Build the full `/ws status` report as a formatted multi-line string.
 *
 * Sections:
 * 1. **Tools** — one line per tool with enabled state, assigned
 *    provider and (when applicable) the `pi-requesty` suppression
 *    note.
 * 2. **Credenciales** — the detected Exa API key with its source
 *    (`auth.json` or `EXA_API_KEY`) and a masked value, or the public
 *    free mode when no key is used.
 * 3. **pi-requesty** — the `nativeSearch` flag and the `web_search`
 *    suppression decision for `currentModel`.
 *
 * @param currentModel Optional current model object used to evaluate
 *   the `pi-requesty` compatibility rules; when omitted, no model
 *   suppression is applied.
 */
export async function buildWsStatusReport(
  currentModel?: unknown
): Promise<string> {
  const config = await getConfig();
  const suppression = await shouldSuppressWebSearch(currentModel);
  const nativeSearchEnabled = await isRequestyNativeSearchEnabled();

  // Tools section: same ToolStatus snapshots as the interactive hub,
  // rendered as plain text for the notification.
  const toolStatuses = buildHubToolStatuses(config, suppression);
  const toolLines = toolStatuses.map((status) => renderToolLine(status));

  // Credentials section: report the detected Exa API key
  // and its source, masked, or the public free mode.
  const useApiKey = config.providers.exa.useApiKey;
  const storedKey = readStoredCredential(EXA_PROVIDER_KEY)?.key ?? null;
  const effectiveKey = getExaApiKey(useApiKey);
  let credentialsLine: string;
  if (!useApiKey) {
    credentialsLine =
      "  Exa: public mode without API Key (useApiKey: No)";
  } else if (effectiveKey !== null) {
    const source =
      storedKey !== null ? "auth.json" : "EXA_API_KEY (environment)";
    credentialsLine = `  Exa: API Key detected in ${source} (${maskKey(effectiveKey)})`;
  } else {
    credentialsLine =
      "  Exa: without API Key (free public mode, global limits)";
  }

  // pi-requesty section.
  const nativeSearchLine = `  nativeSearch: ${
    nativeSearchEnabled ? "enabled" : "disabled"
  }`;
  const suppressionLine = suppression.shouldSuppress
    ? `  web_search: suppressed${
        suppression.reason !== undefined ? ` — ${suppression.reason}` : ""
      }`
    : `  web_search: not suppressed${
        suppression.reason !== undefined ? ` — ${suppression.reason}` : ""
      }`;

  return [
    "🌐 Web Scout — Current Status",
    "",
    "Tools:",
    ...toolLines,
    "",
    "Credentials:",
    credentialsLine,
    "",
    "pi-requesty:",
    nativeSearchLine,
    suppressionLine,
  ].join("\n");
}

/**
 * Command handler for `/ws status`: builds the
 * full status report and delivers it as an info notification.
 *
 * The current model is taken from `ctx.model` so the `pi-requesty`
 * compatibility state reflects the active model of the session.
 */
export async function handleWsStatus(
  ctx: ExtensionCommandContext
): Promise<void> {
  const report = await buildWsStatusReport(ctx.model);
  ctx.ui.notify(report, "info");
}
