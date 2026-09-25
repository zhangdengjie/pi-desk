type LabelledThread = { title?: string; firstMessage?: string };

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
