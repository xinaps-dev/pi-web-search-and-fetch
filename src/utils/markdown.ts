/**
 * Semantic Markdown truncation utilities.
 *
 * `truncateMarkdown` cuts long web content at a natural boundary (paragraph,
 * line, or word) instead of slicing mid-word, repairs broken Markdown
 * syntax at the cut point (incomplete links, unclosed code fences) and
 * appends an informational truncation marker.
 */

/**
 * Marker appended after truncated content, indicating how many characters
 * the original text was limited to.
 */
function truncationNotice(maxCharacters: number): string {
  return `\n\n[... Contenido truncado a ${maxCharacters} caracteres ...]`;
}

/**
 * Finds a natural cut point at or before `maxCharacters`.
 *
 * Preference order:
 * 1. Last paragraph boundary `\n\n` found at least 50% of `maxCharacters`
 *    into the text.
 * 2. Last single newline `\n` found at least 50% of `maxCharacters` into
 *    the text.
 * 3. Last space ` ` before `maxCharacters`.
 * 4. `maxCharacters` itself (hard slice).
 */
function findNaturalCutPoint(text: string, maxCharacters: number): number {
  const slice = text.slice(0, maxCharacters);
  const minimum = Math.floor(maxCharacters / 2);

  const paragraph = slice.lastIndexOf("\n\n");
  if (paragraph >= minimum) {
    return paragraph;
  }

  const newline = slice.lastIndexOf("\n");
  if (newline >= minimum) {
    return newline;
  }

  const space = slice.lastIndexOf(" ");
  if (space >= 0) {
    return space;
  }

  return maxCharacters;
}

/**
 * Removes a trailing incomplete Markdown link.
 *
 * Trims back before the last `[` when:
 * - the last `[` has no matching `]` after it, or
 * - the link opened at the last `[` contains a `(` with no matching `)`
 *   (e.g. `[texto](http...` cut before the closing parenthesis).
 */
function cleanBrokenLink(text: string): string {
  const lastOpen = text.lastIndexOf("[");
  if (lastOpen === -1) {
    return text;
  }
  const lastClose = text.lastIndexOf("]");
  if (lastOpen > lastClose) {
    return text.slice(0, lastOpen);
  }
  const segment = text.slice(lastOpen);
  const openParen = segment.indexOf("(");
  if (openParen !== -1 && segment.indexOf(")", openParen) === -1) {
    return text.slice(0, lastOpen);
  }
  return text;
}

/**
 * Closes an unclosed Markdown code fence.
 *
 * Counts triple-backtick delimiters; if the count is odd, the truncated
 * text leaves a code block open, so a closing fence is appended.
 */
function balanceCodeFences(text: string): string {
  const fences = text.match(/```/g);
  const count = fences ? fences.length : 0;
  if (count % 2 === 1) {
    return `${text}\n\`\`\`\n`;
  }
  return text;
}

/**
 * Truncates `text` to at most `maxCharacters` characters using semantic
 * Markdown-aware rules.
 *
 * Behaviour:
 * - If `text.length <= maxCharacters`, returns `text` unchanged.
 * - If `maxCharacters <= 0`, returns only the truncation marker.
 * - Otherwise cuts at a natural point (paragraph `\n\n`, then line `\n`,
 *   then space, then hard slice), repairs a broken trailing Markdown link,
 *   closes an unclosed code fence and appends the truncation marker
 *   `\n\n[... Contenido truncado a ${maxCharacters} caracteres ...]`.
 *
 * @param text - The full Markdown text.
 * @param maxCharacters - Maximum number of source characters to keep.
 * @returns The truncated text with a trailing truncation marker.
 */
export function truncateMarkdown(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) {
    return text;
  }
  if (maxCharacters <= 0) {
    return truncationNotice(maxCharacters);
  }

  let truncated = text.slice(0, findNaturalCutPoint(text, maxCharacters));
  truncated = cleanBrokenLink(truncated);
  truncated = balanceCodeFences(truncated);
  return truncated + truncationNotice(maxCharacters);
}
