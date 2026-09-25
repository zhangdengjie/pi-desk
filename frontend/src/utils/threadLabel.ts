type LabelledThread = { title?: string; firstMessage?: string };

/**
 * Keep in step with `maxTitleRunes` in internal/sessionindex/index.go: the indexer already hands us
 * at most that many runes, so cutting to anything smaller (it was 40) throws away half a string for
 * a reason the layout no longer has - the topbar title, the sidebar row and the inspector row all
 * ellipsize or wrap on their own since 3c15ad8.
 */
export const THREAD_TITLE_MAX_CHARS = 80;

/**
 * Derives a readable sidebar title from a raw first prompt: first line only, markdown and URL noise
 * stripped, long URLs reduced to their host, and a clean single-character ellipsis instead of a
 * mid-token cut.
 */
export function threadTitleText(value: string): string {
  const firstLine = value.split("\n").find((line) => line.trim())?.trim() ?? "";
  const cleaned = firstLine
    .replace(/^#+\s*/, "")
    .replace(/`+/g, "")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/(?:https?:\/\/|www\.)([a-z0-9.-]+(?::\d+)?)[^\s<>()"'，。；、！？：]*\/?/gi, (_match, host: string) => host.replace(/^www\./, ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (cleaned.length <= THREAD_TITLE_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, THREAD_TITLE_MAX_CHARS - 1)}…`;
}

/**
 * Hover text for a thread title. The visible string stays the short title - this only decides what
 * the tooltip adds.
 *
 * Why the tooltip needs more than the title: Pi names a session from the first prompt and cuts that
 * name short, so the stored title can literally end in an ellipsis (it is part of the string, not
 * CSS). Widening the CSS never recovers those characters; `firstMessage` is the copy that still has
 * them (indexed at up to 400 runes by internal/sessionindex).
 */
export function threadTooltip(thread?: LabelledThread | null): string {
  const title = thread?.title?.trim() ?? "";
  const first = thread?.firstMessage?.trim() ?? "";
  if (!first || title.startsWith(first)) return title;
  if (!title || first.startsWith(title)) return first;
  return `${title}\n\n${first}`;
}
