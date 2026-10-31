/**
 * Turning a text selection in the transcript into a draft-ready blockquote.
 *
 * Kept free of DOM access so the rules can be tested without a Selection: the component decides
 * *what* is selected, this decides *what the draft gets*.
 */

/** How much of a selection a quote may carry. A whole answer can be thousands of characters, and
 *  quoting all of it would bury the composer and spend context on text the model already has. */
export const SELECTION_QUOTE_MAX = 800;

/**
 * The selection as the reader sees it: CRLF normalised, trailing spaces dropped, runs of blank lines
 * collapsed to one, and cut at `max` on a character boundary with an ellipsis. Markdown syntax in the
 * selection is left alone - it is quoted text, and the reader may well want the emphasis preserved.
 */
export function normalizeSelectionText(raw: string, max = SELECTION_QUOTE_MAX): string {
  const collapsed = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (collapsed.length <= max) return collapsed;
  // `Array.from` so a surrogate pair (an emoji, a rare CJK glyph) is never cut in half.
  return Array.from(collapsed).slice(0, max).join("").trimEnd() + "…";
}

/** A blockquote: every line prefixed, blank lines kept as a bare `>` so the block stays one quote. */
export function formatSelectionQuote(raw: string, max = SELECTION_QUOTE_MAX): string {
  const text = normalizeSelectionText(raw, max);
  if (!text) return "";
  return text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
}

/**
 * Where the quote lands in the existing draft. Two blank lines separate it from what was already
 * there (the reader is usually mid-thought and wants to write *below* the quote), but the separator
 * never eats what the draft already ends with: a single trailing newline means the reader was
 * already on a new line, and stripping to `\n\n` there would insert a blank line they did not ask
 * for. Nothing is trimmed from the draft itself - a trailing double space is a markdown hard break.
 */
export function appendQuoteToDraft(draft: string, quote: string): string {
  if (!quote) return draft;
  const separator = draft === "" ? "" : draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
  return `${draft}${separator}${quote}\n\n`;
}