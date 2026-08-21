/**
 * Detection and synchronization helpers for the `pi-requesty` integration.
 *
 * `pi-web-scout` must coexist with the `pi-requesty` extension: when
 * Requesty has `nativeSearch: true` and the active model is a Requesty
 * model with native web search support (`supportsWebSearch: true`) that is
 * not a Gemini model (Gemini models fail when function calling is combined
 * with native search), `pi-web-scout` must suppress `web_search` to avoid
 * duplication and conflicts with the Requesty server. `web_fetch` is always
 * kept active by the caller; this module only decides about `web_search`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../config/auth.js";
import type { WebSearchSuppression } from "../types.js";

/** File name of the `pi-requesty` config file. */
export const REQUESTY_CONFIG_FILE_NAME = "pi-requesty.json";

/** Provider identifier used by `pi-requesty` models. */
export const REQUESTY_PROVIDER_ID = "requesty";

/**
 * Full path of the `pi-requesty` config file
 * (`~/.pi/agent/pi-requesty.json`), overridable via `PI_AGENT_DIR`
 * for tests.
 */
export function getRequestyConfigPath(): string {
  return path.join(getAgentDir(), REQUESTY_CONFIG_FILE_NAME);
}

/**
 * Read the `nativeSearch` flag from `~/.pi/agent/pi-requesty.json`.
 * Returns `true` only when the file exists, is valid JSON,
 * is a JSON object and has `nativeSearch: true`. Missing, unreadable or
 * malformed files yield `false`.
 */
export async function isRequestyNativeSearchEnabled(): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(getRequestyConfigPath(), "utf8");
  } catch {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }

  return (parsed as Record<string, unknown>).nativeSearch === true;
}

/**
 * Detect whether a model id belongs to a Gemini model.
 * Gemini models served through Requesty fail when function calling is
 * combined with native search, so they must never suppress `web_search`
 * in favor of Requesty native search.
 */
export function isGeminiModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("gemini");
}

/**
 * The subset of the current model object that this module inspects.
 * `currentModel` is accepted as `unknown` so the integration
 * stays decoupled from any concrete Pi model type.
 */
export interface RequestyModelInfo {
  /** Provider id of the model; must be `requesty` for suppression. */
  provider?: string;
  /** Model id, used for Gemini detection. */
  id?: string;
  /** Whether the model supports native web search. */
  supportsWebSearch?: boolean;
}

/**
 * Narrow an unknown model value to the fields this module inspects.
 * Returns `null` when the value is not a plain object.
 */
function asModelInfo(currentModel: unknown): RequestyModelInfo | null {
  if (typeof currentModel !== "object" || currentModel === null) {
    return null;
  }
  return currentModel as RequestyModelInfo;
}

/**
 * Evaluate whether `web_search` must be suppressed for the current model
 * (Compatibility Rules).
 *
 * Suppression happens only when ALL of the following hold:
 * 1. the current model's provider is `requesty`;
 * 2. `pi-requesty` has `nativeSearch: true` in its config file;
 * 3. the model is not a Gemini model (Gemini models fail when function
 *    calling is combined with native search);
 * 4. the model has `supportsWebSearch: true`.
 *
 * In every other case `shouldSuppress` is `false` and `web_search` stays
 * active according to the regular `pi-web-scout` configuration.
 */
export async function shouldSuppressWebSearch(
  currentModel: unknown
): Promise<WebSearchSuppression> {
  const model = asModelInfo(currentModel);
  if (model === null || typeof model.provider !== "string") {
    return {
      shouldSuppress: false,
      reason: "current model is not a Requesty model",
    };
  }
  if (model.provider.toLowerCase() !== REQUESTY_PROVIDER_ID) {
    return {
      shouldSuppress: false,
      reason: "current model provider is not requesty",
    };
  }

  const nativeSearchEnabled = await isRequestyNativeSearchEnabled();
  if (!nativeSearchEnabled) {
    return {
      shouldSuppress: false,
      reason: "pi-requesty nativeSearch is disabled",
    };
  }

  if (
    typeof model.id === "string" &&
    model.id !== "" &&
    isGeminiModel(model.id)
  ) {
    return {
      shouldSuppress: false,
      reason:
        "Gemini models do not support combining function calling with native search",
    };
  }

  if (model.supportsWebSearch !== true) {
    return {
      shouldSuppress: false,
      reason: "current model does not support native web search",
    };
  }

  return {
    shouldSuppress: true,
    reason:
      "Requesty native search is active for the current model; web_search is suppressed to avoid duplication",
  };
}
