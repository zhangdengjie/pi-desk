/**
 * GitHub-compatible heading anchor, with one deliberate exception: CJK letters survive.
 *
 * The stock `markdown-it-anchor` slugify drops everything outside `\w-`, so a Chinese heading -
 * which is most of what this app previews - would slug to the empty string and every entry in the
 * outline would collide. Unicode property escapes keep `\p{L}` (Han included) and `\p{N}`.
 */
export function slugifyHeading(value: string): string {
  const slug = value
    .toLocaleLowerCase()
    // `<br>` survives normalizeMarkdownBreakTags as a literal inside the heading's own text, and
    // emphasis/code markers are markup, not words - both must not reach the anchor.
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\p{M}._-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

/**
 * Deduplicate slugs the way GitHub does: the second `## Setup` becomes `setup-1`.
 * `counts` is owned by a single render pass, so it has to be recreated per render - a map that
 * outlives the pass would keep growing `-1`, `-2` suffixes every time the same text re-renders.
 */
export function uniqueHeadingSlug(counts: Map<string, number>, value: string): string {
  const slug = slugifyHeading(value);
  const seen = counts.get(slug);
  counts.set(slug, (seen ?? 0) + 1);
  return seen === undefined ? slug : `${slug}-${seen}`;
}

export function normalizeMarkdownBreakTags(value: string): string {
  let normalized = "";
  let cursor = 0;
  let fence: { marker: "`" | "~"; length: number } | undefined;

  while (cursor < value.length) {
    const atLineStart = cursor === 0 || value[cursor - 1] === "\n";
    if (atLineStart) {
      const lineEnd = value.indexOf("\n", cursor);
      const end = lineEnd === -1 ? value.length : lineEnd + 1;
      const line = value.slice(cursor, lineEnd === -1 ? value.length : lineEnd);

      if (fence) {
        const closing = /^ {0,3}([`~]+)\s*$/.exec(line);
        normalized += value.slice(cursor, end);
        cursor = end;
        if (closing?.[1]?.[0] === fence.marker && closing[1].length >= fence.length) fence = undefined;
        continue;
      }

      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (opening) {
        fence = { marker: opening[0] as "`" | "~", length: opening.length };
        normalized += value.slice(cursor, end);
        cursor = end;
        continue;
      }
    }

    if (value[cursor] === "`") {
      let runEnd = cursor + 1;
      while (value[runEnd] === "`") runEnd += 1;
      const delimiter = value.slice(cursor, runEnd);
      let closing = value.indexOf(delimiter, runEnd);
      while (closing !== -1 && (value[closing - 1] === "`" || value[closing + delimiter.length] === "`")) {
        closing = value.indexOf(delimiter, closing + delimiter.length);
      }
      if (closing !== -1) {
        const end = closing + delimiter.length;
        normalized += value.slice(cursor, end);
        cursor = end;
        continue;
      }
    }

    const breakTag = /^<\/?br\s*\/?>/i.exec(value.slice(cursor))?.[0];
    if (breakTag) {
      normalized += "\n";
      cursor += breakTag.length;
      continue;
    }

    // A Markdown hard break serialised as `\` + line ending. Both call sites already treat a bare
    // newline as a break (`breaks: true` in the renderer, and the editor parses `A\nB` back into a
    // hardbreak node), so the escape is pure noise - and it leaked into the prompt sent to Pi as a
    // literal backslash. Leave an escaped `\\` alone; code spans and fences were consumed above.
    if (value[cursor] === "\\" && value[cursor + 1] === "\n" && value[cursor - 1] !== "\\") {
      normalized += "\n";
      cursor += 2;
      continue;
    }

    normalized += value[cursor];
    cursor += 1;
  }

  return normalized;
}
