import { describe, expect, it } from "vitest";
import { truncateMarkdown } from "../src/utils/markdown.js";

function notice(maxCharacters: number): string {
  return `\n\n[... Contenido truncado a ${maxCharacters} caracteres ...]`;
}

describe("src/utils/markdown", () => {
  describe("short text preservation", () => {
    it("returns the original text when text.length < maxCharacters", () => {
      expect(truncateMarkdown("hello world", 50)).toBe("hello world");
    });

    it("returns the original text when text.length === maxCharacters", () => {
      expect(truncateMarkdown("abc", 3)).toBe("abc");
    });

    it("returns an empty string unchanged", () => {
      expect(truncateMarkdown("", 10)).toBe("");
    });
  });

  describe("maxCharacters <= 0", () => {
    it("returns only the truncation notice for maxCharacters = 0", () => {
      expect(truncateMarkdown("hello world", 0)).toBe(notice(0));
    });

    it("returns only the truncation notice for negative maxCharacters", () => {
      expect(truncateMarkdown("hello world", -5)).toBe(notice(-5));
    });
  });

  describe("double newline paragraph cut", () => {
    it("cuts at the last paragraph boundary \\n\\n when available", () => {
      const text =
        "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
      const result = truncateMarkdown(text, 40);
      expect(result).toBe("First paragraph.\n\nSecond paragraph." + notice(40));
    });

    it("does not cut mid-paragraph when a \\n\\n boundary is in range", () => {
      const text =
        "Alpha beta gamma.\n\nDelta epsilon zeta.\n\nEta theta iota kappa.";
      const result = truncateMarkdown(text, 45);
      // Last \n\n at index 38 (>= 22) wins over the later single \n.
      expect(result).toBe("Alpha beta gamma.\n\nDelta epsilon zeta." + notice(45));
    });
  });

  describe("single newline cut", () => {
    it("cuts at the last \\n when no \\n\\n is in range", () => {
      const text = "line one\nline two\nline three";
      const result = truncateMarkdown(text, 20);
      expect(result).toBe("line one\nline two" + notice(20));
    });
  });

  describe("space boundary cut", () => {
    it("cuts at the last space without breaking a word", () => {
      const text = "aaaa bbbb cccc dddd eeee";
      const result = truncateMarkdown(text, 15);
      expect(result).toBe("aaaa bbbb cccc" + notice(15));
    });

    it("never leaves a partial word at the end of the cut", () => {
      const text = "word one two three four five six seven";
      const result = truncateMarkdown(text, 25);
      // Last space in slice(0,25) is at index 21 -> "word one two three four"
      expect(result).toBe("word one two three four" + notice(25));
    });
  });

  describe("hard slice cut", () => {
    it("slices exactly at maxCharacters when no space or newline exists", () => {
      const result = truncateMarkdown("aaaaaaaaaa", 7);
      expect(result).toBe("aaaaaaa" + notice(7));
    });
  });

  describe("code block fence balancing", () => {
    it("appends a closing fence when a code block is left open", () => {
      const text = "Intro\n\n```\ncode line\nmore code\nstill open";
      const result = truncateMarkdown(text, 20);
      // Cut at the \n at index 10 -> "Intro\n\n```" (odd fence count).
      expect(result).toBe("Intro\n\n```\n```\n" + notice(20));
    });

    it("does not add an extra fence when the fence count is even", () => {
      const text = "```\ncode\n```\n\nMore text here after the block";
      const result = truncateMarkdown(text, 25);
      // Cut at the \n\n at index 12 -> "```\ncode\n```" (even fence count).
      expect(result).toBe("```\ncode\n```" + notice(25));
      expect(result).not.toContain("```\n```\n");
    });
  });

  describe("broken link cleanup", () => {
    it("trims back before [ when the closing bracket is missing", () => {
      const text = "Intro here\n\nSee [texto largo](https://incomplete";
      const result = truncateMarkdown(text, 40);
      // Cut at the space at index 22 -> "Intro here\n\nSee [texto".
      // cleanBrokenLink trims back before the last '['.
      expect(result).toBe("Intro here\n\nSee " + notice(40));
      expect(result.slice(0, -notice(40).length)).not.toContain("[");
    });

    it("trims back before [ when the link has no closing parenthesis", () => {
      const text = "Intro here\n\nSee [texto](https://incomplete host";
      const result = truncateMarkdown(text, 45);
      // Cut leaves "[texto](https://incomplete" open -> trimmed before '['.
      expect(result).toBe("Intro here\n\nSee " + notice(45));
      expect(result).not.toContain("](");
    });

    it("preserves a fully closed link inside the cut point", () => {
      const text =
        "Intro here\n\nSee [valid](https://link.com) and more text here";
      const result = truncateMarkdown(text, 44);
      // Cut at the space at index 40 -> "Intro here\n\nSee [valid](https://link.com)".
      // The complete link is preserved intact.
      expect(result).toBe("Intro here\n\nSee [valid](https://link.com)" + notice(44));
    });
  });

  describe("truncation notice format", () => {
    it("appends the exact notice with the maxCharacters value", () => {
      const result = truncateMarkdown("some text that is long enough to be cut", 20);
      expect(result.endsWith(notice(20))).toBe(true);
      expect(result).toContain(
        "\n\n[... Contenido truncado a 20 caracteres ...]"
      );
    });

    it("reflects a custom maxCharacters in the notice", () => {
      const result = truncateMarkdown("some text that is long enough to be cut", 12);
      expect(result).toContain(
        "\n\n[... Contenido truncado a 12 caracteres ...]"
      );
    });
  });
});
