/**
 * Custom TUI renderers for the web tools exposed to the LLM.
 *
 * `renderCall(toolName)` returns a `ToolDefinition.renderCall`-compatible
 * renderer that displays the parameters sent by the model in a consistent,
 * elegant single line (e.g. `web_search "query" (numResults: 8)`).
 *
 * `renderTruncatedResult` is a `ToolDefinition.renderResult`-compatible
 * renderer that shows extensive tool results truncated (collapsed) in the
 * chat history, with a hint to expand them, matching the rendering style of
 * the built-in Pi tools.
 */

import { Text, type Component } from "@earendil-works/pi-tui";
import {
  keyHint,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

/**
 * Structural subset of Pi's internal `ToolRenderContext` used by these
 * renderers (the full context type is not exported from the package root).
 */
export interface WsToolRenderContext {
  /** Previously returned component for this render slot, if any. */
  lastComponent: Component | undefined;
}

/**
 * Maximum number of characters shown for a single string argument in a tool
 * call line; longer values are elided with an ellipsis.
 */
export const TOOL_CALL_ARG_MAX_CHARS = 80;

/**
 * Number of result lines shown while the result view is collapsed in the
 * chat history; the expanded view shows every line.
 */
export const TRUNCATED_RESULT_COLLAPSED_LINES = 20;

/**
 * Elide a string to at most `maxChars` characters, appending an ellipsis
 * when the value was truncated.
 */
function elide(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Names of the parameters that are always rendered as the primary
 * (accented) argument of a tool call line, e.g. `query` for searches,
 * `url`/`urls` for fetches.
 */
const PRIMARY_PARAM_KEYS: readonly string[] = ["query", "url", "urls"];

/**
 * Whether a value is an array whose every element is a string
 * (e.g. the `urls: string[]` batch parameter of `web_fetch`).
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Format a single non-primary argument value for a tool call line:
 * strings are quoted, numbers/booleans are plain, arrays are rendered
 * recursively and anything else falls back to JSON.
 */
function formatArgValue(value: unknown): string {
  if (typeof value === "string") {
    return value === "" ? '""' : `"${elide(value, TOOL_CALL_ARG_MAX_CHARS)}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return `[${value.map((item) => formatArgValue(item)).join(", ")}]`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Format the tool call line shown in the Pi console/TUI: a bold tool title,
 * the primary parameter in the accent color, and the remaining parameters
 * in a muted `(key: value, ...)` group. `undefined`/`null` parameters are
 * omitted.
 *
 * The primary parameter is a named primary key (`query`, `url`, `urls`)
 * holding a string or string-array value, or the first string/
 * string-array entry as a fallback. String primaries are rendered quoted
 * and elided; string-array primaries (e.g. `urls`) are rendered via
 * {@link formatArgValue}.
 */
export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  theme: Theme
): string {
  const entries = Object.entries(args).filter(
    ([, value]) => value !== undefined && value !== null
  );

  let line = theme.fg("toolTitle", theme.bold(toolName));

  const primary =
    entries.find(
      ([key, value]) =>
        PRIMARY_PARAM_KEYS.includes(key) &&
        (typeof value === "string" || isStringArray(value))
    ) ??
    entries.find(
      ([, value]) => typeof value === "string" || isStringArray(value)
    );

  if (primary !== undefined) {
    const primaryValue = primary[1];
    line +=
      typeof primaryValue === "string"
        ? ` ${theme.fg(
            "accent",
            `"${elide(primaryValue, TOOL_CALL_ARG_MAX_CHARS)}"`
          )}`
        : ` ${theme.fg("accent", formatArgValue(primaryValue))}`;
  }

  const secondary = entries.filter(([key]) => key !== primary?.[0]);
  if (secondary.length > 0) {
    line += theme.fg(
      "toolOutput",
      ` (${secondary
        .map(([key, value]) => `${key}: ${formatArgValue(value)}`)
        .join(", ")})`
    );
  }

  return line;
}

/**
 * Create the `renderCall` renderer for a web tool.
 *
 * The returned function is directly assignable to
 * `ToolDefinition.renderCall`: it renders the parameters sent by the model
 * via {@link formatToolCall} into a `Text` component, reusing the previous
 * component for the render slot when Pi provides one.
 */
export function renderCall(
  toolName: string
): (
  args: Record<string, unknown>,
  theme: Theme,
  context: WsToolRenderContext
) => Component {
  return (args, theme, context) => {
    // The previous component in this render slot is always the Text created
    // by this renderer.
    const text =
      (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    text.setText(formatToolCall(toolName, args, theme));
    return text;
  };
}

/**
 * Extract the plain text output from a tool result (text content blocks
 * joined by newlines, carriage returns removed).
 */
function extractTextOutput(result: AgentToolResult<unknown>): string {
  if (!result || !Array.isArray(result.content)) {
    return "";
  }
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text.replace(/\r/g, ""))
    .join("\n");
}

/**
 * Format an extensive tool result for the chat history:
 * while collapsed, only a concise single-line hint is displayed
 * (e.g. `(45 lines, to expand)`), keeping the terminal UI clean and minimal;
 * the expanded view displays every line with toolOutput styling.
 */
export function formatTruncatedResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme
): string {
  const output = extractTextOutput(result).trim();
  if (output === "") {
    return "";
  }

  if (options.expanded) {
    return `\n${output
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n")}`;
  }

  const lines = output.split("\n");
  const lineWord = lines.length === 1 ? "line" : "lines";
  const hint = `(${lines.length} ${lineWord}, ${keyHint(
    "app.tools.expand",
    "to expand"
  )})`;
  return theme.fg("muted", hint);
}

/**
 * The `renderResult` renderer for web tools, directly
 * assignable to `ToolDefinition.renderResult`: renders extensive results
 * truncated/collapsible in the chat history via
 * {@link formatTruncatedResult}, reusing the previous component for the
 * render slot when Pi provides one.
 */
export function renderTruncatedResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: WsToolRenderContext
): Component {
  // The previous component in this render slot is always the Text created
  // by this renderer.
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(formatTruncatedResult(result, options, theme));
  return text;
}
