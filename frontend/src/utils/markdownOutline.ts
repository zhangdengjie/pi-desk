import { outlineLevels, type MarkdownHeading } from "./markdown";

/** One row of an outline. `offset` is 0 when no scroller was measured against. */
export interface MarkdownOutlineEntry extends MarkdownHeading {
  offset: number;
}

/**
 * The outline of a rendered Markdown document, read back out of the DOM the renderer produced.
 *
 * Deliberately not a source scan. MarkdownBody stamps an id on every heading it renders, so the rules
 * that decide what is addressable are the same ones that decide what appears here: a `#` inside a
 * fenced block, a heading in a document the 100k-character guard refused to render, or a level the
 * renderer never reached cannot leak into the list. It also means the id in the list *is* the id on
 * the element - they carry a per-instance prefix, so nothing outside this document can name them, and
 * a jump has to be resolved by the component that made them.
 *
 * `h1`-`h4` only: at five levels deep an outline stops being a map of the document and becomes a wall
 * of links, in a pane that is 240px wide at its smallest.
 *
 * `scroller` is the element that actually scrolls (the preview pane). Content coordinates are what a
 * jump needs: `offsetTop` measures against the nearest *positioned* ancestor and ignores how far the
 * reader has already gone, while a rect moves with the scroll - so the scroll is added back.
 */
export function collectMarkdownOutline(root: HTMLElement, scroller?: HTMLElement): MarkdownOutlineEntry[] {
  const scrollBox = scroller ?? root;
  const entries = Array.from(root.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id]")).map((element) => ({
    id: element.id,
    level: Number(element.tagName.slice(1)) || 4,
    title: element.textContent?.trim() || element.id,
    offset: element.getBoundingClientRect().top - scrollBox.getBoundingClientRect().top + (scroller?.scrollTop ?? 0),
  }));
  return outlineLevels(entries);
}

/**
 * Cheap "is there any point offering an outline" test, run on the source before anything is measured
 * or rendered. It can over-count (`#` inside a fence); the list built by `collectMarkdownOutline` is
 * what the reader actually gets, and an empty one says so.
 */
export function markdownHasHeadings(source: string, minimum = 1): boolean {
  if (minimum <= 1) return /^ {0,3}#{1,4}\s+\S/m.test(source);
  let seen = 0;
  for (const _match of source.matchAll(/^ {0,3}#{1,4}\s+\S/gm)) {
    seen += 1;
    if (seen >= minimum) return true;
  }
  return false;
}
