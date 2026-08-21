/**
 * Interactive Exa configuration modal.
 *
 * Built on the shared TUI form utilities (`src/ui/forms.ts`). The modal
 * shows:
 * - a `[ Use API Key: Yes / No ]` toggle initialized from
 *   `pi-web-scout.json` (`providers.exa.useApiKey`);
 * - a masked "Exa API Key" text field initialized with the key currently
 *   stored in `~/.pi/agent/auth.json`;
 * - explanatory text about public free mode (global limits) vs private
 *   quota (the user's own Exa account).
 *
 * On save the modal persists securely:
 * - `updateConfig({ providers: { exa: { useApiKey } } })` persists the
 *   toggle in `pi-web-scout.json` (atomic write);
 * - with the toggle on and a non-empty key, `writeExaApiKey(key)` stores
 *   the key in `auth.json` with `0o600` permissions;
 * - with the toggle on and an empty key, the previously stored key is
 *   kept (e.g. resolution may still fall back to `EXA_API_KEY`);
 * - with the toggle off, `removeExaApiKey()` removes the Exa credential
 *   so the session runs in public free mode.
 *
 * The returned `FormComponent` is ready to be returned from a
 * `ctx.ui.custom()` factory; the caller wires `onSubmit`/`onCancel` to
 * resolve the overlay's `done` callback.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  EXA_PROVIDER_KEY,
  readStoredCredential,
  removeExaApiKey,
  writeExaApiKey,
} from "../../config/auth.js";
import { getConfig, updateConfig } from "../../config/index.js";
import {
  createForm,
  type FormComponent,
  type FormSpec,
} from "../../ui/forms.js";

/** Values collected by the Exa configuration modal. */
export interface ExaModalValues {
  /** State of the "Use API Key" toggle. */
  useApiKey: boolean;
  /** Raw value of the "Exa API Key" text field. */
  apiKey: string;
}

/**
 * Callbacks for the Exa configuration modal. `onSubmit` is invoked only
 * after persistence has completed, so callers can safely resolve the
 * `ctx.ui.custom()` overlay from it.
 */
export interface ExaModalCallbacks {
  /** Called with the collected values after the config was persisted. */
  onSubmit?: (values: ExaModalValues) => void;
  /** Called when the user cancels (Escape); nothing is persisted. */
  onCancel?: () => void;
}

/**
 * Explanatory lines shown in the modal: public free mode
 * uses Exa's public MCP endpoint subject to global limits, while API key
 * mode uses the user's own Exa quota.
 */
export const EXA_MODAL_INFO: string[] = [
  "Without API Key (public mode): uses the free public Exa MCP endpoint,",
  "subject to global limits. With API Key (private mode): uses your own",
  "Exa account quota and the key is saved to auth.json (0o600).",
];

/**
 * Persist the Exa configuration securely:
 * updates `providers.exa.useApiKey` in `pi-web-scout.json` and writes or
 * removes the Exa credential in `auth.json` accordingly.
 */
export async function persistExaConfig(values: ExaModalValues): Promise<void> {
  const useApiKey = values.useApiKey;
  const key = values.apiKey.trim();

  await updateConfig({ providers: { exa: { useApiKey } } });

  if (useApiKey) {
    if (key.length > 0) {
      writeExaApiKey(key);
    }
  } else {
    removeExaApiKey();
  }
}

/**
 * Build the interactive Exa configuration modal as a `FormComponent`.
 *
 * Loads the current state before rendering:
 * - `useApiKey` from `pi-web-scout.json` (default when missing);
 * - `apiKey` from the stored `auth.json` credential (empty when none).
 *
 * The component is a pi-tui `Component`/`Focusable` and can be returned
 * directly from a `ctx.ui.custom()` factory.
 */
export async function createExaConfigModal(
  theme: Theme,
  callbacks: ExaModalCallbacks = {}
): Promise<FormComponent> {
  const config = await getConfig();
  const storedKey = readStoredCredential(EXA_PROVIDER_KEY)?.key ?? "";

  const spec: FormSpec = {
    title: "Exa - Configuration",
    fields: [
      {
        id: "useApiKey",
        label: "Use API Key",
        kind: "toggle",
        value: config.providers.exa.useApiKey,
      },
      {
        id: "apiKey",
        label: "Exa API Key",
        kind: "text",
        value: storedKey,
        secret: true,
      },
    ],
    info: EXA_MODAL_INFO,
  };

  return createForm(spec, theme, {
    onSubmit: (values) => {
      const useApiKey = values.useApiKey as boolean;
      const apiKey = values.apiKey as string;
      void (async () => {
        await persistExaConfig({ useApiKey, apiKey });
        callbacks.onSubmit?.({ useApiKey, apiKey });
      })();
    },
    onCancel: () => {
      callbacks.onCancel?.();
    },
  });
}
