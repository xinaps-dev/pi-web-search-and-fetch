/**
 * Interactive `/ws` Hub / Dashboard TUI component.
 *
 * When `/ws` is executed without arguments in interactive mode
 * (`ctx.hasUI`), the hub is shown as a keyboard-focused overlay
 * (`ctx.ui.custom`). It renders:
 *
 * - a bold title (`🌐 Web Search and Fetch - Control Panel`);
 * - a visual summary of the state of the three tools and their active
 *   providers, one line per tool:
 *
 *   ```text
 *   [✓] Search (web_search)          : ON  (Provider: exa)
 *   [✓] Fetch (web_fetch)           : ON  (Provider: exa)
 *   [ ] Deep Search (deep)          : OFF (Provider: exa)
 *   ```
 *
 * - an "Actions" quick-action menu navigable with the arrow keys
 *   (and executed with `Enter`/`Space`), plus `Escape` to exit:
 *
 *   ```text
 *   > Assign Providers (3-tool wizard)
 *   > Configure Active Provider (Exa API Key / Mode)
 *   > View Detailed Status
 *   > Exit
 *   ```
 *
 * The component is a pi-tui `Component` (and `Focusable`), so the caller
 * (the `/ws` no-argument handler) can return it directly from a
 * `ctx.ui.custom()` factory and wire `onAction`/`onExit` to launch the
 * provider selector assistant (`src/ui/selector.ts`), the active
 * provider's config modal (e.g. `src/providers/exa/ui.ts`), the detailed
 * status view and the overlay's `done` callback.
 *
 * Tool state lines come from `ToolStatus` snapshots (see `src/types.ts`),
 * which can be built from the config with {@link buildHubToolStatuses}.
 */

import {
  Key,
  Spacer,
  Text,
  VStack,
  matchesKey,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TOOL_IDS } from "../config/constants.js";
import type { PiWebSearchAndFetchConfig } from "../config/types.js";
import type {
  ToolStatus,
  WebSearchSuppression,
  WsToolId,
} from "../types.js";

/** Default hub title. */
export const HUB_TITLE = "🌐 Web Search and Fetch - Control Panel";

/** Identifiers of the default quick actions of the hub. */
export const HUB_ACTION_IDS = {
  /** Launch the 3-step provider selector assistant. */
  providers: "providers",
  /** Launch the active provider's configuration modal. */
  configure: "configure",
  /** Show the detailed status (`/ws status`). */
  status: "status",
  /** Close the hub. */
  exit: "exit",
} as const;

/**
 * A quick action entry of the hub menu.
 */
export interface HubActionSpec {
  /** Unique identifier reported to `onAction`. */
  id: string;
  /** Human-readable label shown in the menu. */
  label: string;
  /** Optional extra description (rendered muted, when present). */
  description?: string;
}

/**
 * Default quick actions of the hub:
 * - assign providers (3-tool wizard);
 * - configure the active provider (Exa API key / mode);
 * - show the detailed status;
 * - exit.
 */
export const DEFAULT_HUB_ACTIONS: HubActionSpec[] = [
  {
    id: HUB_ACTION_IDS.providers,
    label: "Assign Providers (3-tool wizard)",
  },
  {
    id: HUB_ACTION_IDS.configure,
    label: "Configure Providers",
  },
  {
    id: HUB_ACTION_IDS.status,
    label: "View Detailed Status",
  },
  {
    id: HUB_ACTION_IDS.exit,
    label: "Exit",
  },
];

/** Options describing what the hub displays. */
export interface HubComponentOptions {
  /** State of the three tools and their active providers. */
  toolStatuses: ToolStatus[];
  /** Quick actions (defaults to {@link DEFAULT_HUB_ACTIONS}). */
  actions?: HubActionSpec[];
  /** Panel title (defaults to {@link HUB_TITLE}). */
  title?: string;
}

/**
 * Callbacks invoked by the hub. The hub does not know about Pi's `done`
 * overlay callback; the caller wires these to launch the
 * action and to close the overlay.
 */
export interface HubComponentCallbacks {
  /** Called with the id of the action executed (Enter/Space). */
  onAction?: (actionId: string) => void;
  /** Called when the user exits (Escape or the "Salir" action). */
  onExit?: () => void;
}

/**
 * A focusable, keyboard-driven hub/dashboard component.
 *
 * Compose one per hub session via {@link createHubComponent}. The
 * component is a pi-tui `Component` (and `Focusable`), so it can be
 * returned directly from a `ctx.ui.custom()` factory.
 *
 * - Up / Down → move through the quick actions (clamped).
 * - Enter / Space → execute the highlighted action (`onAction`).
 * - Escape → `onExit`.
 */
export class HubComponent implements Component, Focusable {
  /** Set by the TUI when this component has keyboard focus. */
  focused = false;

  private readonly theme: Theme;
  private readonly title: string;
  private readonly toolStatuses: ToolStatus[];
  private readonly actions: HubActionSpec[];
  private readonly callbacks: HubComponentCallbacks;
  private readonly root: VStack;
  private readonly toolTexts: Text[] = [];
  private readonly actionTexts: Text[] = [];
  private activeIndex = 0;
  private disposed = false;
  // Assigned in the constructor once the child components are built.
  private titleText!: Text;
  private actionsLabel!: Text;
  private hintText!: Text;

  constructor(
    options: HubComponentOptions,
    theme: Theme,
    callbacks: HubComponentCallbacks = {}
  ) {
    this.theme = theme;
    this.title = options.title ?? HUB_TITLE;
    this.toolStatuses = options.toolStatuses;
    this.actions = options.actions ?? DEFAULT_HUB_ACTIONS;
    this.callbacks = callbacks;

    const children: Component[] = [new Text("", 0, 0)]; // title slot
    children.push(new Spacer(1));
    for (const _status of this.toolStatuses) {
      this.toolTexts.push(new Text("", 0, 0));
    }
    for (const text of this.toolTexts) {
      children.push(text);
    }
    children.push(new Spacer(1));
    const actionsLabel = new Text("", 0, 0);
    children.push(actionsLabel);
    for (const _action of this.actions) {
      this.actionTexts.push(new Text("", 0, 0));
    }
    for (const text of this.actionTexts) {
      children.push(text);
    }
    const hintText = new Text("", 0, 0);
    children.push(hintText);

    this.root = new VStack(children);
    this.titleText = children[0] as Text;
    this.actionsLabel = actionsLabel;
    this.hintText = hintText;

    this.rebuild();
  }

  /** The quick action currently highlighted. */
  get activeAction(): HubActionSpec | undefined {
    return this.actions[this.activeIndex];
  }

  /**
   * Keyboard entry point (called by the TUI while the hub is focused).
   *
   * - Escape → exit
   * - Enter / Space → execute the highlighted action
   * - Up / Down → move through the quick actions (clamped)
   */
  handleInput(data: string): void {
    if (this.disposed) {
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.exit();
      return;
    }
    if (
      matchesKey(data, Key.enter) ||
      data === "\n" ||
      matchesKey(data, Key.space)
    ) {
      const action = this.activeAction;
      if (action !== undefined) {
        this.callbacks.onAction?.(action.id);
      }
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.move(1);
      return;
    }
  }

  /** Render the hub to lines for the given viewport width. */
  render(width: number): string[] {
    return this.root.render(width);
  }

  /** Invalidate cached rendering (theme change / external invalidation). */
  invalidate(): void {
    this.root.invalidate();
  }

  /** Release resources. Safe to call more than once. */
  dispose(): void {
    this.disposed = true;
  }

  /** Exit the hub. */
  exit(): void {
    if (this.disposed) {
      return;
    }
    this.callbacks.onExit?.();
  }

  /** Move the highlighted action by `delta` (clamped to the list). */
  private move(delta: number): void {
    if (this.actions.length === 0) {
      return;
    }
    const next = this.activeIndex + delta;
    if (next < 0 || next >= this.actions.length) {
      return;
    }
    this.activeIndex = next;
    this.rebuild();
  }

  /** Recompute every dynamic line from the current state. */
  private rebuild(): void {
    this.titleText.setText(this.theme.bold(this.title));

    for (let i = 0; i < this.toolStatuses.length; i++) {
      this.toolTexts[i].setText(this.renderToolLine(this.toolStatuses[i]));
    }

    this.actionsLabel.setText(this.theme.fg("text", "Actions:"));

    for (let i = 0; i < this.actions.length; i++) {
      this.actionTexts[i].setText(this.renderActionLine(i));
    }

    this.hintText.setText(
      this.theme.fg("muted", "↑/↓ move · Enter/space select · Esc exit")
    );
  }

  /**
   * Render one tool state line:
   * `[✓] Search (web_search) : ON (Provider: exa)` — `[ ]` / `OFF`
   * when the tool is disabled, plus a muted suppression note when the
   * `pi-requesty` integration suppresses the tool.
   */
  private renderToolLine(status: ToolStatus): string {
    const label = TOOL_LABELS[status.toolId] ?? status.toolId;
    const box = status.enabled
      ? this.theme.fg("accent", "[✓]")
      : this.theme.fg("muted", "[ ]");
    const state = status.enabled
      ? this.theme.fg("accent", "ON")
      : this.theme.fg("muted", "OFF");

    let line = `${box} ${this.theme.fg("text", label)} : ${state} ${this.theme.fg(
      "text",
      `(Provider: ${status.providerId})`
    )}`;

    if (status.suppressed) {
      const reason = status.reason !== undefined ? `: ${status.reason}` : "";
      line += this.theme.fg("muted", ` (suppressed${reason})`);
    }

    return line;
  }

  /** Render one quick-action line, marking the highlighted action. */
  private renderActionLine(index: number): string {
    const action = this.actions[index];
    const active = index === this.activeIndex;
    const marker = active ? this.theme.fg("accent", ">") : " ";
    const label = this.theme.fg(
      active ? "text" : "muted",
      action.label
    );
    const description =
      action.description !== undefined
        ? ` ${this.theme.fg("muted", action.description)}`
        : "";
    return `${marker} ${label}${description}`;
  }
}

/**
 * User-facing labels of the three tools in the hub.
 */
const TOOL_LABELS: Record<WsToolId, string> = {
  [TOOL_IDS.search]: "Search (web_search)",
  [TOOL_IDS.fetch]: "Fetch (web_fetch)",
  [TOOL_IDS.deepSearch]: "Deep Search (web_deep_search)",
};

/**
 * Build the `ToolStatus` snapshot for the hub from the extension config,
 * in the stable tool order `web_search`, `web_fetch`, `web_deep_search`.
 *
 * When the `pi-requesty` integration suppresses `web_search`,
 * pass the suppression result to flag it in the summary.
 */
export function buildHubToolStatuses(
  config: PiWebSearchAndFetchConfig,
  suppression?: WebSearchSuppression
): ToolStatus[] {
  const statuses: ToolStatus[] = [
    {
      toolId: TOOL_IDS.search,
      enabled: config.search.enabled,
      providerId: config.search.provider,
    },
    {
      toolId: TOOL_IDS.fetch,
      enabled: config.fetch.enabled,
      providerId: config.fetch.provider,
    },
    {
      toolId: TOOL_IDS.deepSearch,
      enabled: config.deepSearch.enabled,
      providerId: config.deepSearch.provider,
    },
  ];

  if (suppression?.shouldSuppress) {
    statuses[0].suppressed = true;
    if (suppression.reason !== undefined) {
      statuses[0].reason = suppression.reason;
    }
  }

  return statuses;
}

/**
 * Build a {@link HubComponent} ready to be returned from a
 * `ctx.ui.custom()` factory:
 *
 * ```ts
 * ctx.ui.custom((_tui, theme, _kb, done) => {
 *   const hub = createHubComponent({ toolStatuses }, theme, {
 *     onAction: (id) => { void launchAction(id, done); },
 *     onExit: () => done(),
 *   });
 *   return hub;
 * });
 * ```
 */
export function createHubComponent(
  options: HubComponentOptions,
  theme: Theme,
  callbacks: HubComponentCallbacks = {}
): HubComponent {
  return new HubComponent(options, theme, callbacks);
}
