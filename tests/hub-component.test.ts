import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/constants.js";
import {
  DEFAULT_HUB_ACTIONS,
  HUB_ACTION_IDS,
  HUB_TITLE,
  buildHubToolStatuses,
  createHubComponent,
  type HubComponent,
  type HubComponentCallbacks,
  type HubComponentOptions,
} from "../src/ui/hub-component.js";
import type { ToolStatus } from "../src/types.js";

/** Identity mock theme: returns the text unchanged (plain-text asserts). */
function mockTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

/** Standard tool statuses: search/fetch ON, deep OFF (defaults). */
function defaultStatuses(): ToolStatus[] {
  return [
    { toolId: "web_search", enabled: true, providerId: "exa" },
    { toolId: "web_fetch", enabled: true, providerId: "exa" },
    { toolId: "web_deep_search", enabled: false, providerId: "exa" },
  ];
}

function makeHub(
  options: Partial<HubComponentOptions> = {},
  callbacks?: HubComponentCallbacks
): HubComponent {
  return createHubComponent(
    { toolStatuses: defaultStatuses(), ...options },
    mockTheme(),
    callbacks
  );
}

/** Render a component to lines, stripping right padding. */
function renderLines(component: Component, width = 200): string {
  return component
    .render(width)
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

// Raw terminal sequences (see pi-tui keys.js).
const ESC = "\x1b";
const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SPACE = " ";

describe("src/ui/hub-component", () => {
  describe("initial render", () => {
    it("renders the hub title", () => {
      expect(renderLines(makeHub())).toContain(HUB_TITLE);
    });

    it("renders the enabled search tool with [✓], ON and its provider", () => {
      const out = renderLines(makeHub());
      expect(out).toContain("[✓] Search (web_search) : ON (Provider: exa)");
    });

    it("renders the enabled fetch tool with [✓], ON and its provider", () => {
      const out = renderLines(makeHub());
      expect(out).toContain("[✓] Fetch (web_fetch) : ON (Provider: exa)");
    });

    it("renders the disabled deep-search tool with [ ] and OFF", () => {
      const out = renderLines(makeHub());
      expect(out).toContain(
        "[ ] Deep Search (web_deep_search) : OFF (Provider: exa)"
      );
    });

    it("renders an 'Actions' section with the default quick actions", () => {
      const out = renderLines(makeHub());
      expect(out).toContain("Actions:");
      expect(out).toContain("Assign Providers (3-tool wizard)");
      expect(out).toContain("Configure Providers");
      expect(out).toContain("View Detailed Status");
      expect(out).toContain("Exit");
    });

    it("marks the first action as active with a leading '>'", () => {
      const lines = renderLines(makeHub()).split("\n");
      expect(
        lines.some((l) => l.startsWith("> Assign Providers"))
      ).toBe(true);
    });

    it("renders a keyboard hint line", () => {
      expect(renderLines(makeHub())).toContain("Enter/space select");
    });

    it("shows the suppression note when a tool is suppressed", () => {
      const statuses = buildHubToolStatuses(DEFAULT_CONFIG, {
        shouldSuppress: true,
        reason: "Requesty native search active",
      });
      const out = renderLines(makeHub({ toolStatuses: statuses }));
      expect(out).toContain("(suppressed: Requesty native search active)");
    });

    it("uses custom actions and title when provided", () => {
      const out = renderLines(
        makeHub({
          title: "My Hub",
          actions: [{ id: "x", label: "Action X" }],
        })
      );
      expect(out).toContain("My Hub");
      expect(out).toContain("Action X");
      expect(out).not.toContain("Exit");
    });
  });

  describe("navigation", () => {
    it("moves down through the quick actions with the down arrow", () => {
      const hub = makeHub();
      hub.handleInput(DOWN);
      let out = renderLines(hub);
      expect(out).toContain("> Configure Providers");
      expect(out).not.toContain("> Assign Providers");

      hub.handleInput(DOWN);
      out = renderLines(hub);
      expect(out).toContain("> View Detailed Status");

      hub.handleInput(DOWN);
      out = renderLines(hub);
      expect(out).toContain("> Exit");
    });

    it("moves up with the up arrow and clamps at the first action", () => {
      const hub = makeHub();
      hub.handleInput(DOWN);
      hub.handleInput(DOWN);
      hub.handleInput(UP);
      hub.handleInput(UP);
      hub.handleInput(UP); // clamped, stays first
      expect(renderLines(hub)).toContain("> Assign Providers");
    });

    it("clamps at the last action", () => {
      const hub = makeHub();
      hub.handleInput(DOWN);
      hub.handleInput(DOWN);
      hub.handleInput(DOWN);
      hub.handleInput(DOWN); // clamped, stays last
      expect(renderLines(hub)).toContain("> Exit");
    });

    it("tracks the active action via the getter", () => {
      const hub = makeHub();
      expect(hub.activeAction?.id).toBe(HUB_ACTION_IDS.providers);
      hub.handleInput(DOWN);
      expect(hub.activeAction?.id).toBe(HUB_ACTION_IDS.configure);
      hub.handleInput(UP);
      expect(hub.activeAction?.id).toBe(HUB_ACTION_IDS.providers);
    });
  });

  describe("action execution and exit", () => {
    it("executes the highlighted action on Enter", () => {
      const executed: string[] = [];
      const hub = makeHub({
        actions: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      }, {
        onAction: (id) => executed.push(id),
      });

      hub.handleInput(ENTER);
      hub.handleInput(DOWN);
      hub.handleInput(ENTER);
      expect(executed).toEqual(["a", "b"]);
    });

    it("executes the highlighted action on Space", () => {
      let executed: string[] = [];
      const hub = makeHub(
        { actions: [{ id: "a", label: "A" }] },
        { onAction: (id) => (executed = [id]) }
      );
      hub.handleInput(SPACE);
      expect(executed).toEqual(["a"]);
    });

    it("executes on newline as well", () => {
      let executed: string[] = [];
      const hub = makeHub(
        { actions: [{ id: "a", label: "A" }] },
        { onAction: (id) => (executed = [id]) }
      );
      hub.handleInput("\n");
      expect(executed).toEqual(["a"]);
    });

    it("does not execute anything when there are no actions", () => {
      let called = false;
      const hub = makeHub(
        { actions: [] },
        { onAction: () => (called = true) }
      );
      hub.handleInput(ENTER);
      expect(called).toBe(false);
    });

    it("exits on Escape", () => {
      let exited = false;
      const hub = makeHub({}, { onExit: () => (exited = true) });
      hub.handleInput(ESC);
      expect(exited).toBe(true);
    });

    it("reports the exit action id when 'Exit' is executed", () => {
      const actions: string[] = [];
      let exited = false;
      const hub = makeHub(
        {
          actions: [
            { id: "x", label: "X" },
            { id: HUB_ACTION_IDS.exit, label: "Exit" },
          ],
        },
        {
          onAction: (id) => actions.push(id),
          onExit: () => (exited = true),
        }
      );
      // The hub only reports the action; the caller wires the
      // `exit` action to `done`. Verify the exit action id is reported.
      hub.handleInput(DOWN);
      hub.handleInput(ENTER);
      expect(actions).toEqual([HUB_ACTION_IDS.exit]);
      expect(exited).toBe(false);
    });
  });

  describe("dispose", () => {
    it("ignores input after dispose", () => {
      let exited = false;
      const hub = makeHub({}, { onExit: () => (exited = true) });
      hub.dispose();
      hub.handleInput(ESC);
      expect(exited).toBe(false);
    });

    it("is a pi-tui Component (render/invalidate) and Focusable", () => {
      const hub = makeHub();
      expect(typeof hub.render).toBe("function");
      expect(typeof hub.invalidate).toBe("function");
      expect(typeof hub.handleInput).toBe("function");
      expect(typeof hub.dispose).toBe("function");
      expect(hub.focused).toBe(false);
    });
  });
});

describe("buildHubToolStatuses", () => {
  it("maps the config sections to ToolStatus in stable tool order", () => {
    const statuses = buildHubToolStatuses(DEFAULT_CONFIG);
    expect(statuses).toEqual([
      { toolId: "web_search", enabled: true, providerId: "exa" },
      { toolId: "web_fetch", enabled: true, providerId: "exa" },
      { toolId: "web_deep_search", enabled: false, providerId: "exa" },
    ]);
  });

  it("reflects disabled tools and other providers", () => {
    const statuses = buildHubToolStatuses({
      search: { enabled: false, provider: "brave" },
      fetch: { enabled: true, provider: "jina" },
      deepSearch: { enabled: true, provider: "exa" },
      providers: { exa: { useApiKey: false } },
    });
    expect(statuses).toEqual([
      { toolId: "web_search", enabled: false, providerId: "brave" },
      { toolId: "web_fetch", enabled: true, providerId: "jina" },
      { toolId: "web_deep_search", enabled: true, providerId: "exa" },
    ]);
  });

  it("flags web_search as suppressed when requested", () => {
    const statuses = buildHubToolStatuses(DEFAULT_CONFIG, {
      shouldSuppress: true,
      reason: "Requesty native search",
    });
    expect(statuses[0].suppressed).toBe(true);
    expect(statuses[0].reason).toBe("Requesty native search");
    expect(statuses[1].suppressed).toBeUndefined();
    expect(statuses[2].suppressed).toBeUndefined();
  });

  it("does not flag suppression when shouldSuppress is false", () => {
    const statuses = buildHubToolStatuses(DEFAULT_CONFIG, {
      shouldSuppress: false,
    });
    expect(statuses[0].suppressed).toBeUndefined();
  });
});

describe("DEFAULT_HUB_ACTIONS", () => {
  it("contains the four quick actions in order", () => {
    expect(DEFAULT_HUB_ACTIONS.map((a) => a.id)).toEqual([
      HUB_ACTION_IDS.providers,
      HUB_ACTION_IDS.configure,
      HUB_ACTION_IDS.status,
      HUB_ACTION_IDS.exit,
    ]);
  });
});
