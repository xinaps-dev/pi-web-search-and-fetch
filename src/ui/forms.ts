/**
 * Shared TUI form and toggle utilities built on `@earendil-works/pi-tui`.
 *
 * These helpers render interactive forms (title, labelled toggle and text
 * fields, explanatory notes and action buttons) that plug directly into
 * Pi's `ctx.ui.custom()` overlay API. The Exa configuration modal
 * and any future provider modal are built on top of
 * {@link createForm}.
 *
 * A form is a single focusable `Component`: Pi gives it keyboard focus and
 * forwards every keystroke to {@link FormComponent.handleInput}. The form
 * navigates between fields with the arrow keys (and Tab / Shift+Tab),
 * toggles boolean fields with the left/right arrows or space, edits text
 * fields (a simple single-line editor with an exact cursor), submits on
 * Enter and cancels on Escape.
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

/** The kind of a form field. */
export type FormFieldKind = "toggle" | "text";

/**
 * Declarative description of a single form field.
 *
 * - `toggle` fields are boolean and rendered as `[ <label>: Yes / No ]`.
 * - `text` fields are string and rendered as `<label>: <value>`.
 */
export interface FormFieldSpec {
  /** Unique identifier used as the key in the submitted values. */
  id: string;
  /** Human-readable label shown to the left of the field. */
  label: string;
  /** Field kind. */
  kind: FormFieldKind;
  /** Initial value: `boolean` for `toggle`, `string` for `text`. */
  value: boolean | string;
  /**
   * When `true` the text field masks its value (one bullet per character),
   * e.g. for API keys. Ignored for `toggle` fields.
   */
  secret?: boolean;
}

/** Declarative description of a whole form. */
export interface FormSpec {
  /** Bold title rendered at the top of the form. */
  title: string;
  /** Ordered list of fields. */
  fields: FormFieldSpec[];
  /** Optional explanatory lines shown under the fields (muted). */
  info?: string[];
  /** Optional submit label (retained for backward compatibility). */
  submitLabel?: string;
  /** Optional cancel label (retained for backward compatibility). */
  cancelLabel?: string;
}

/** Collected field values keyed by field id. */
export type FormValues = Record<string, boolean | string>;

/**
 * Callbacks invoked when the form is submitted or cancelled. The form does
 * not know about Pi's `done` overlay callback; callers (e.g. the Exa modal)
 * wire these to resolve the `ctx.ui.custom()` promise.
 */
export interface FormCallbacks {
  /** Called with the collected values when the user submits (Enter). */
  onSubmit?: (values: FormValues) => void;
  /** Called when the user cancels (Escape). */
  onCancel?: () => void;
}

/**
 * A focusable, keyboard-driven form component.
 *
 * Compose one per modal via {@link createForm}. The component is a pi-tui
 * `Component` (and `Focusable`), so it can be returned directly from a
 * `ctx.ui.custom()` factory.
 */
export class FormComponent implements Component, Focusable {
  /** Set by the TUI when this component has keyboard focus. */
  focused = false;

  private readonly spec: FormSpec;
  private readonly theme: Theme;
  private readonly callbacks: FormCallbacks;
  private readonly fields: FormFieldSpec[];
  private readonly values: FormValues;
  private readonly cursors: Record<string, number>;
  private readonly fieldTexts: Text[];
  private readonly root: VStack;
  private activeIndex = 0;
  private disposed = false;
  private lastFocused = false;
  // Assigned in the constructor once the child components are built.
  private titleText!: Text;
  private infoText!: Text;
  private hintText!: Text;

  constructor(spec: FormSpec, theme: Theme, callbacks: FormCallbacks = {}) {
    this.spec = spec;
    this.theme = theme;
    this.callbacks = callbacks;
    this.fields = spec.fields;

    this.values = {};
    this.cursors = {};
    this.fieldTexts = [];
    for (const field of this.fields) {
      this.values[field.id] = field.value;
      // Text fields start with the cursor at the end of the value.
      this.cursors[field.id] =
        field.kind === "text" ? (field.value as string).length : 0;
      this.fieldTexts.push(new Text("", 0, 0));
    }

    const children: Component[] = [new Text("", 0, 0)]; // title slot
    children.push(new Spacer(1));
    for (const text of this.fieldTexts) {
      children.push(text);
    }
    children.push(new Spacer(1));
    const infoText = new Text("", 0, 0);
    children.push(infoText);
    children.push(new Spacer(1));
    const hintText = new Text("", 0, 0);
    children.push(hintText);

    this.root = new VStack(children);
    this.titleText = children[0] as Text;
    this.infoText = infoText;
    this.hintText = hintText;

    this.rebuild();
  }

  /** The field currently highlighted. */
  get activeField(): FormFieldSpec | undefined {
    return this.fields[this.activeIndex];
  }

  /** Read the current value of a single field. */
  getValue(id: string): boolean | string | undefined {
    return this.values[id];
  }

  /** Snapshot of all current field values. */
  getValues(): FormValues {
    return { ...this.values };
  }

  /**
   * Keyboard entry point (called by the TUI while the form is focused).
   *
   * - Escape → cancel
   * - Enter  → submit
   * - Up / Down / Tab / Shift+Tab → move between fields
   * - Left / Right / Space → toggle the active boolean field
   * - anything else → edit the active text field
   */
  handleInput(data: string): void {
    if (this.disposed) {
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.cancel();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\n") {
      this.submit();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab"))) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
      this.move(1);
      return;
    }

    const field = this.activeField;
    if (field === undefined) {
      return;
    }

    if (field.kind === "toggle") {
      if (
        matchesKey(data, Key.left) ||
        matchesKey(data, Key.right) ||
        matchesKey(data, Key.space)
      ) {
        this.values[field.id] = !(this.values[field.id] as boolean);
        this.rebuild();
      }
      return;
    }

    this.editText(field.id, data);
  }

  /** Render the form to lines for the given viewport width. */
  render(width: number): string[] {
    // The active text field's cursor depends on focus, which the TUI flips
    // between renders without going through handleInput. Rebuild when it
    // changes so the cursor appears/disappears correctly.
    if (this.lastFocused !== this.focused) {
      this.lastFocused = this.focused;
      this.rebuild();
    }
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

  /** Submit the form with the collected values. */
  submit(): void {
    if (this.disposed) {
      return;
    }
    this.callbacks.onSubmit?.(this.getValues());
  }

  /** Cancel the form. */
  cancel(): void {
    if (this.disposed) {
      return;
    }
    this.callbacks.onCancel?.();
  }

  /** Move the active field by `delta` (clamped to the field list). */
  private move(delta: number): void {
    if (this.fields.length === 0) {
      return;
    }
    const next = this.activeIndex + delta;
    if (next < 0 || next >= this.fields.length) {
      return;
    }
    this.activeIndex = next;
    this.rebuild();
  }

  /**
   * Edit the text field `id` in place (single-line editor): inserts
   * printable characters (bracketed-paste markers stripped), handles
   * backspace / forward-delete and cursor movement, and keeps the cursor
   * clamped to the value length.
   */
  private editText(id: string, data: string): void {
    const before = this.values[id] as string;
    let cursor = this.cursors[id];

    // Bracketed paste: strip the start/end markers so the pasted payload is
    // inserted as plain text.
    let payload = data.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");

    if (matchesKey(data, Key.backspace)) {
      if (cursor > 0) {
        this.values[id] = before.slice(0, cursor - 1) + before.slice(cursor);
        cursor -= 1;
      }
    } else if (matchesKey(data, Key.delete)) {
      if (cursor < before.length) {
        this.values[id] = before.slice(0, cursor) + before.slice(cursor + 1);
      }
    } else if (matchesKey(data, Key.left)) {
      cursor = Math.max(0, cursor - 1);
    } else if (matchesKey(data, Key.right)) {
      cursor = Math.min(before.length, cursor + 1);
    } else if (matchesKey(data, Key.home)) {
      cursor = 0;
    } else if (matchesKey(data, Key.end)) {
      cursor = before.length;
    } else if (payload.length > 0 && !this.hasControlChars(payload)) {
      const next = before.slice(0, cursor) + payload + before.slice(cursor);
      this.values[id] = next;
      cursor += payload.length;
    } else {
      // Unhandled key for a text field: leave the value untouched.
      return;
    }

    this.cursors[id] = Math.min(cursor, (this.values[id] as string).length);
    this.rebuild();
  }

  /** True when the string contains any C0/C1 control or DEL character. */
  private hasControlChars(text: string): boolean {
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
        return true;
      }
    }
    return false;
  }

  /** Recompute every dynamic line from the current state. */
  private rebuild(): void {
    this.titleText.setText(this.theme.bold(this.spec.title));

    for (let i = 0; i < this.fields.length; i++) {
      this.fieldTexts[i].setText(this.renderFieldLine(this.fields[i], i));
    }

    this.infoText.setText(
      (this.spec.info ?? [])
        .map((line) => this.theme.fg("muted", line))
        .join("\n")
    );

    this.hintText.setText(
      this.theme.fg(
        "muted",
        "↑/↓ move · ←/→/space toggle · Enter save · Esc cancel"
      )
    );
  }

  /** Render a single field line (label + value, with active marker). */
  private renderFieldLine(field: FormFieldSpec, index: number): string {
    const active = index === this.activeIndex;
    const marker = active
      ? `${this.theme.fg("accent", ">")} `
      : "  ";

    if (field.kind === "toggle") {
      const on = this.values[field.id] as boolean;
      const yes = on
        ? this.theme.fg("accent", "Yes")
        : this.theme.fg("muted", "Yes");
      const no = on
        ? this.theme.fg("muted", "No")
        : this.theme.fg("accent", "No");
      return `${marker}[ ${this.theme.fg("text", field.label)}: ${yes} / ${no} ]`;
    }

    const value = this.values[field.id] as string;
    const display = field.secret ? "•".repeat(value.length) : value;
    return `${marker}${this.theme.fg("text", `${field.label}:`)} ${this.theme.fg(
      "text",
      this.renderValueWithCursor(display, active)
    )}`;
  }

  /**
   * Render a text field value, adding a reverse-video block cursor at the
   * cursor position when the field is active and the form is focused.
   */
  private renderValueWithCursor(display: string, active: boolean): string {
    if (!active || !this.focused) {
      return display;
    }
    const activeField = this.activeField;
    const cursor = activeField
      ? Math.min(this.cursors[activeField.id] ?? display.length, display.length)
      : display.length;
    const before = display.slice(0, cursor);
    const at = display[cursor] ?? " ";
    const after = display.slice(cursor + 1);
    // ESC[7m = reverse video, ESC[27m = normal (same as pi-tui Input).
    return `${before}\x1b[7m${at}\x1b[27m${after}`;
  }
}

/**
 * Build a {@link FormComponent} from a declarative {@link FormSpec}.
 *
 * The returned component is ready to be returned from a `ctx.ui.custom()`
 * factory:
 *
 * ```ts
 * ctx.ui.custom((_tui, theme, _kb, done) => {
 *   const form = createForm(spec, theme, {
 *     onSubmit: (values) => { save(values); done({ submitted: true, values }); },
 *     onCancel: () => done({ submitted: false, values: {} }),
 *   });
 *   return form;
 * });
 * ```
 */
export function createForm(
  spec: FormSpec,
  theme: Theme,
  callbacks?: FormCallbacks
): FormComponent {
  return new FormComponent(spec, theme, callbacks);
}
