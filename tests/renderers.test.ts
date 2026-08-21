import { Text, type Component } from "@earendil-works/pi-tui";
import {
  initTheme,
  type AgentToolResult,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { beforeAll, describe, expect, it } from "vitest";
import {
  formatToolCall,
  formatTruncatedResult,
  renderCall,
  renderTruncatedResult,
  TRUNCATED_RESULT_COLLAPSED_LINES,
  TOOL_CALL_ARG_MAX_CHARS,
  type WsToolRenderContext,
} from "../src/tools/renderers.js";

/** Identity mock theme: returns the text unchanged (plain-text asserts). */
function mockTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

/** Tagging mock theme: wraps each styled fragment with its color name. */
function taggingTheme(): Theme {
  return {
    fg: (color: string, text: string) => `⟨${color}:${text}⟩`,
    bold: (text: string) => `⟨bold:${text}⟩`,
  } as unknown as Theme;
}

const collapsed: ToolRenderResultOptions = {
  expanded: false,
  isPartial: false,
};
const expanded: ToolRenderResultOptions = {
  expanded: true,
  isPartial: false,
};

function textResult(...blocks: string[]): AgentToolResult<unknown> {
  return {
    content: blocks.map((text) => ({ type: "text" as const, text })),
    details: undefined,
  };
}

function emptyContext(): WsToolRenderContext {
  return { lastComponent: undefined };
}

/** Render a component and strip the right padding added by Text.render. */
function renderLines(component: Component, width = 200): string {
  return component
    .render(width)
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

beforeAll(() => {
  // keyHint() renders through Pi's global theme singleton.
  initTheme("dark");
});

describe("src/tools/renderers", () => {
  describe("formatToolCall", () => {
    it("renders only the tool name when no arguments are present", () => {
      expect(formatToolCall("web_search", {}, mockTheme())).toBe("web_search");
    });

    it("renders the primary string argument quoted after the tool name", () => {
      const out = formatToolCall(
        "web_search",
        { query: "TypeScript 5.7 release notes" },
        mockTheme()
      );
      expect(out).toBe('web_search "TypeScript 5.7 release notes"');
    });

    it("renders web_search with optional parameters in a muted group", () => {
      const out = formatToolCall(
        "web_search",
        { query: "pi coding agent", numResults: 8, category: "github" },
        mockTheme()
      );
      expect(out).toBe(
        'web_search "pi coding agent" (numResults: 8, category: "github")'
      );
    });

    it("renders web_fetch with url and maxCharacters", () => {
      const out = formatToolCall(
        "web_fetch",
        { url: "https://example.com/docs", maxCharacters: 15000 },
        mockTheme()
      );
      expect(out).toBe(
        'web_fetch "https://example.com/docs" (maxCharacters: 15000)'
      );
    });

    it("renders a urls string array as the primary argument", () => {
      const out = formatToolCall(
        "web_fetch",
        { urls: ["https://a.com/one", "https://b.com/two"] },
        mockTheme()
      );
      expect(out).toBe('web_fetch ["https://a.com/one", "https://b.com/two"]');
    });

    it("styles the urls string array primary argument in accent color", () => {
      const out = formatToolCall(
        "web_fetch",
        {
          urls: ["https://a.com/one", "https://b.com/two"],
          maxCharacters: 5000,
        },
        taggingTheme()
      );
      expect(out).toContain(
        '⟨accent:["https://a.com/one", "https://b.com/two"]⟩'
      );
      expect(out).toContain("⟨toolOutput: (maxCharacters: 5000)⟩");
      expect(out).not.toContain("urls:");
    });

    it("elides long URLs inside a urls array primary argument", () => {
      const longUrl = `https://example.com/${"a".repeat(TOOL_CALL_ARG_MAX_CHARS)}`;
      const out = formatToolCall(
        "web_fetch",
        { urls: [longUrl, "https://b.com"] },
        mockTheme()
      );
      expect(out).toContain("…");
      expect(out).toContain('"https://b.com"');
    });

    it("renders web_deep_search with additionalQueries arrays", () => {
      const out = formatToolCall(
        "web_deep_search",
        {
          query: "quantum error correction",
          additionalQueries: ["surface codes", "lattice surgery"],
        },
        mockTheme()
      );
      expect(out).toBe(
        'web_deep_search "quantum error correction" (additionalQueries: ["surface codes", "lattice surgery"])'
      );
    });

    it("omits undefined and null parameters", () => {
      const out = formatToolCall(
        "web_search",
        { query: "q", numResults: undefined, category: null },
        mockTheme()
      );
      expect(out).toBe('web_search "q"');
    });

    it("renders an empty string primary argument as empty quotes", () => {
      const out = formatToolCall("web_search", { query: "" }, mockTheme());
      expect(out).toBe('web_search ""');
    });

    it("elides long string arguments with an ellipsis", () => {
      const long = "a".repeat(TOOL_CALL_ARG_MAX_CHARS + 20);
      const out = formatToolCall("web_search", { query: long }, mockTheme());
      expect(out).toContain("…");
      const quoted = out.slice(out.indexOf('"') + 1, out.lastIndexOf('"'));
      expect(quoted.length).toBe(TOOL_CALL_ARG_MAX_CHARS);
    });

    it("falls back to JSON for non-primitive secondary arguments", () => {
      const out = formatToolCall(
        "web_search",
        { query: "q", extra: { a: 1 } },
        mockTheme()
      );
      expect(out).toBe('web_search "q" (extra: {"a":1})');
    });

    it("styles the tool title, primary argument and extra parameters", () => {
      const out = formatToolCall(
        "web_search",
        { query: "q", numResults: 8 },
        taggingTheme()
      );
      expect(out).toContain("⟨toolTitle:⟨bold:web_search⟩⟩");
      expect(out).toContain("⟨accent:\"q\"⟩");
      expect(out).toContain("⟨toolOutput: (numResults: 8)⟩");
    });
  });

  describe("renderCall", () => {
    it("returns a Text component rendering the call line", () => {
      const component = renderCall("web_search")(
        { query: "hello world" },
        mockTheme(),
        emptyContext()
      );
      expect(component).toBeInstanceOf(Text);
      expect(renderLines(component)).toBe('web_search "hello world"');
    });

    it("reuses the previous component for the render slot", () => {
      const previous = new Text("", 0, 0);
      const component = renderCall("web_fetch")(
        { url: "https://example.com" },
        mockTheme(),
        { lastComponent: previous }
      );
      expect(component).toBe(previous);
      expect(renderLines(component)).toBe(
        'web_fetch "https://example.com"'
      );
    });
  });

  describe("formatTruncatedResult", () => {
    it("returns an empty string when the result has no text output", () => {
      expect(
        formatTruncatedResult({ content: [], details: undefined }, collapsed, mockTheme())
      ).toBe("");
      expect(
        formatTruncatedResult(textResult("   \n  "), collapsed, mockTheme())
      ).toBe("");
    });

    it("renders a concise hint line with line count when collapsed", () => {
      const outSingle = formatTruncatedResult(
        textResult("only one line"),
        collapsed,
        mockTheme()
      );
      expect(outSingle).toContain("1 line,");
      expect(outSingle).toContain("to expand");

      const outMulti = formatTruncatedResult(
        textResult("line1\nline2\nline3"),
        collapsed,
        mockTheme()
      );
      expect(outMulti).toContain("3 lines,");
      expect(outMulti).toContain("to expand");
    });

    it("shows every line with toolOutput styling when the result view is expanded", () => {
      const lines = ["line1", "line2", "line3"];
      const out = formatTruncatedResult(
        textResult(lines.join("\n")),
        expanded,
        mockTheme()
      );
      expect(out).toBe("\nline1\nline2\nline3");
      expect(out).not.toContain("to expand");
    });

    it("joins multiple text blocks and removes carriage returns when expanded", () => {
      const out = formatTruncatedResult(
        textResult("first\r\nsecond", "third"),
        expanded,
        mockTheme()
      );
      expect(out).toBe("\nfirst\nsecond\nthird");
    });
  });

  describe("renderTruncatedResult", () => {
    it("returns a Text component rendering the collapsed hint", () => {
      const lines = ["line1", "line2", "line3"];
      const component = renderTruncatedResult(
        textResult(lines.join("\n")),
        collapsed,
        mockTheme(),
        emptyContext()
      );
      expect(component).toBeInstanceOf(Text);
      const rendered = renderLines(component);
      expect(rendered).toContain("3 lines,");
      expect(rendered).toContain("to expand");
    });

    it("reuses the previous component for the render slot", () => {
      const previous = new Text("", 0, 0);
      const component = renderTruncatedResult(
        textResult("hello"),
        collapsed,
        mockTheme(),
        { lastComponent: previous }
      );
      expect(component).toBe(previous);
      expect(renderLines(component)).toContain("1 line,");
    });
  });

  describe("ToolDefinition compatibility", () => {
    it("is assignable to ToolDefinition renderCall/renderResult", () => {
      const schema = Type.Object({
        query: Type.String({ description: "Search query" }),
        numResults: Type.Optional(Type.Number()),
      });
      const definition: ToolDefinition<typeof schema> = {
        name: "web_search",
        label: "web_search",
        description: "Search the web",
        parameters: schema,
        execute: async () => ({ content: [], details: undefined }),
        renderCall: renderCall("web_search"),
        renderResult: renderTruncatedResult,
      };
      expect(definition.renderCall).toBeTypeOf("function");
      expect(definition.renderResult).toBeTypeOf("function");
    });
  });
});
