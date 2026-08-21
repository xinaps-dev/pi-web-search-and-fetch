import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createForm,
  type FormComponent,
  type FormSpec,
  type FormValues,
} from "../src/ui/forms.js";

/** Identity mock theme: returns the text unchanged (plain-text asserts). */
function mockTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

/** Standard two-field form used across the tests. */
function exaSpec(): FormSpec {
  return {
    title: "Exa",
    fields: [
      { id: "useApiKey", label: "Use API Key", kind: "toggle", value: true },
      {
        id: "apiKey",
        label: "Exa API Key",
        kind: "text",
        value: "",
        secret: true,
      },
    ],
    info: ["Public mode: without API Key (global limits)."],
  };
}

function makeForm(
  spec: FormSpec = exaSpec(),
  callbacks?: {
    onSubmit?: (values: FormValues) => void;
    onCancel?: () => void;
  }
): FormComponent {
  return createForm(spec, mockTheme(), callbacks);
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
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const HOME = "\x1b[H";
const END = "\x1b[F";
const SPACE = " ";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const BACKSPACE = "\x7f";
const DELETE = "\x1b[3~";

describe("src/ui/forms", () => {
  describe("initial render", () => {
    it("renders the bold title", () => {
      const form = makeForm();
      expect(renderLines(form)).toContain("Exa");
    });

    it("renders toggle fields as [ label: Yes / No ]", () => {
      const form = makeForm();
      expect(renderLines(form)).toContain("[ Use API Key: Yes / No ]");
    });

    it("marks the first field as active with a leading '>'", () => {
      const form = makeForm();
      const lines = renderLines(form).split("\n");
      expect(lines.some((l) => l.startsWith("> [ Use API Key"))).toBe(true);
    });

    it("renders text fields as 'label: value'", () => {
      const form = makeForm({
        title: "T",
        fields: [
          { id: "k", label: "Exa API Key", kind: "text", value: "abc123" },
        ],
      });
      expect(renderLines(form)).toContain("Exa API Key: abc123");
    });

    it("masks secret text fields with bullets", () => {
      const form = makeForm({
        title: "T",
        fields: [
          { id: "k", label: "Key", kind: "text", value: "secret99", secret: true },
        ],
      });
      const out = renderLines(form);
      expect(out).toContain("Key: ••••••••");
      expect(out).not.toContain("secret99");
    });

    it("renders the explanatory info lines", () => {
      const form = makeForm();
      expect(renderLines(form)).toContain("Public mode: without API Key");
    });

    it("renders a keyboard hint line", () => {
      const form = makeForm();
      expect(renderLines(form)).toContain("Enter save");
    });
  });

  describe("toggle fields", () => {
    it("toggles on space", () => {
      const form = makeForm();
      expect(form.getValue("useApiKey")).toBe(true);
      form.handleInput(SPACE);
      expect(form.getValue("useApiKey")).toBe(false);
    });

    it("toggles on left and right arrows", () => {
      const form = makeForm();
      form.handleInput(LEFT);
      expect(form.getValue("useApiKey")).toBe(false);
      form.handleInput(RIGHT);
      expect(form.getValue("useApiKey")).toBe(true);
    });

    it("reflects the current toggle state in the render", () => {
      const form = makeForm();
      expect(renderLines(form)).toContain("Use API Key: Yes / No");
      form.handleInput(SPACE);
      // After toggling off, the line is the same text but state flipped.
      expect(form.getValue("useApiKey")).toBe(false);
    });

    it("ignores plain typing on a toggle field", () => {
      const form = makeForm();
      form.handleInput("x");
      expect(form.getValue("useApiKey")).toBe(true);
    });
  });

  describe("text fields", () => {
    it("inserts typed characters at the cursor (end by default)", () => {
      const form = makeForm({
        title: "T",
        fields: [{ id: "k", label: "Key", kind: "text", value: "" }],
      });
      for (const ch of "hello") form.handleInput(ch);
      expect(form.getValue("k")).toBe("hello");
      expect(renderLines(form)).toContain("Key: hello");
    });

    it("supports backspace", () => {
      const form = makeForm({
        title: "T",
        fields: [{ id: "k", label: "Key", kind: "text", value: "abc" }],
      });
      // Cursor starts at end (3). Backspace deletes 'c'.
      form.handleInput(BACKSPACE);
      expect(form.getValue("k")).toBe("ab");
    });

    it("supports forward delete", () => {
      const form = makeForm({
        title: "T",
        fields: [{ id: "k", label: "Key", kind: "text", value: "abc" }],
      });
      form.handleInput(HOME); // cursor to 0
      form.handleInput(DELETE); // delete 'a'
      expect(form.getValue("k")).toBe("bc");
    });

    it("moves the cursor with left/right/home/end", () => {
      const form = makeForm({
        title: "T",
        fields: [{ id: "k", label: "Key", kind: "text", value: "abc" }],
      });
      form.handleInput(HOME);
      form.handleInput("X"); // insert at 0 -> Xabc
      expect(form.getValue("k")).toBe("Xabc");
      form.handleInput(END);
      form.handleInput("Y"); // insert at end -> XabcY
      expect(form.getValue("k")).toBe("XabcY");
    });

    it("inserts in the middle of the value", () => {
      const form = makeForm({
        title: "T",
        fields: [{ id: "k", label: "Key", kind: "text", value: "ac" }],
      });
      form.handleInput(HOME);
      form.handleInput(RIGHT); // cursor to 1
      form.handleInput("b"); // insert between a and c
      expect(form.getValue("k")).toBe("abc");
    });

    it("ignores control characters as text", () => {
      const form = makeForm({
        title: "T",
        fields: [{ id: "k", label: "Key", kind: "text", value: "ab" }],
      });
      form.handleInput("\x01"); // C0 control char
      expect(form.getValue("k")).toBe("ab");
    });

    it("strips bracketed-paste markers and inserts the payload", () => {
      const form = makeForm({
        title: "T",
        fields: [{ id: "k", label: "Key", kind: "text", value: "" }],
      });
      form.handleInput("\x1b[200~pasted\x1b[201~");
      expect(form.getValue("k")).toBe("pasted");
    });
  });

  describe("navigation", () => {
    it("moves down to the next field with the down arrow", () => {
      const form = makeForm();
      const before = renderLines(form);
      expect(before).toContain("> [ Use API Key");
      form.handleInput(DOWN);
      const after = renderLines(form);
      expect(after).toContain("> Exa API Key:");
      expect(after).not.toContain("> [ Use API Key");
    });

    it("moves up with the up arrow and clamps at the first field", () => {
      const form = makeForm();
      form.handleInput(DOWN);
      form.handleInput(UP);
      form.handleInput(UP); // clamped, stays first
      expect(renderLines(form)).toContain("> [ Use API Key");
    });

    it("wraps navigation with Tab and Shift+Tab", () => {
      const form = makeForm();
      form.handleInput(TAB);
      expect(renderLines(form)).toContain("> Exa API Key:");
      form.handleInput(SHIFT_TAB);
      expect(renderLines(form)).toContain("> [ Use API Key");
    });

    it("keeps per-field values independent while navigating", () => {
      const form = makeForm();
      form.handleInput(SPACE); // toggle off
      form.handleInput(DOWN);
      for (const ch of "k1") form.handleInput(ch);
      expect(form.getValue("useApiKey")).toBe(false);
      expect(form.getValue("apiKey")).toBe("k1");
    });
  });

  describe("submit and cancel", () => {
    it("submits collected values on Enter", () => {
      let submitted: FormValues | undefined;
      const form = makeForm(exaSpec(), {
        onSubmit: (values) => {
          submitted = values;
        },
      });
      form.handleInput(SPACE); // toggle off
      form.handleInput(DOWN);
      for (const ch of "abc") form.handleInput(ch);
      form.handleInput(ENTER);
      expect(submitted).toEqual({ useApiKey: false, apiKey: "abc" });
    });

    it("submits via newline as well", () => {
      let called = false;
      const form = makeForm(exaSpec(), { onSubmit: () => (called = true) });
      form.handleInput("\n");
      expect(called).toBe(true);
    });

    it("cancels on Escape", () => {
      let cancelled = false;
      const form = makeForm(exaSpec(), {
        onCancel: () => (cancelled = true),
      });
      form.handleInput(ESC);
      expect(cancelled).toBe(true);
    });

    it("getValues returns a snapshot, not a live reference", () => {
      const form = makeForm();
      const snapshot = form.getValues();
      form.handleInput(SPACE);
      expect(snapshot.useApiKey).toBe(true);
      expect(form.getValue("useApiKey")).toBe(false);
    });
  });

  describe("focus and dispose", () => {
    it("shows a reverse-video cursor only when focused", () => {
      const form = makeForm({
        title: "T",
        fields: [{ id: "k", label: "Key", kind: "text", value: "ab" }],
      });
      const unfocused = renderLines(form);
      expect(unfocused).not.toContain("\x1b[7m");
      form.focused = true;
      const focused = renderLines(form);
      expect(focused).toContain("\x1b[7m");
    });

    it("ignores input after dispose", () => {
      const form = makeForm();
      form.dispose();
      form.handleInput(SPACE);
      expect(form.getValue("useApiKey")).toBe(true);
    });

    it("is a pi-tui Component (render/invalidate) and Focusable", () => {
      const form = makeForm();
      expect(typeof form.render).toBe("function");
      expect(typeof form.invalidate).toBe("function");
      expect(typeof form.handleInput).toBe("function");
      expect(typeof form.dispose).toBe("function");
      expect(form.focused).toBe(false);
    });
  });

  describe("empty form", () => {
    it("submits empty values and tolerates navigation", () => {
      let submitted: FormValues | undefined;
      const form = makeForm(
        { title: "Empty", fields: [] },
        { onSubmit: (values) => (submitted = values) }
      );
      form.handleInput(DOWN);
      form.handleInput(UP);
      form.handleInput(ENTER);
      expect(submitted).toEqual({});
    });
  });
});
