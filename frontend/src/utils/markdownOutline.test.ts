import { describe, expect, it } from "vitest";
import { collectMarkdownOutline, markdownHasHeadings } from "./markdownOutline";

function host(html: string): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = html;
  return element;
}

describe("collectMarkdownOutline", () => {
  it("lists rendered headings and rebases their levels onto the shallowest one", () => {
    const entries = collectMarkdownOutline(host('<h2 id="md1-intro">Intro</h2><h3 id="md1-setup">Setup <code>it</code></h3><h2 id="md1-ship">Ship</h2>'));

    // 0-based, because the CSS indents `level-N` and a document that opens on `##` must not spend a
    // whole indent step on an `#` it does not have.
    expect(entries.map((entry) => [entry.id, entry.level, entry.title])).toEqual([
      ["md1-intro", 0, "Intro"],
      ["md1-setup", 1, "Setup it"],
      ["md1-ship", 0, "Ship"],
    ]);
  });

  it("stops at h4 and refuses to list a heading nobody can address", () => {
    const entries = collectMarkdownOutline(host(
      '<h1 id="md1-a">A</h1><h5 id="md1-b">B</h5><h3>No id</h3><p>text</p>',
    ));

    expect(entries.map((entry) => entry.id)).toEqual(["md1-a"]);
    // One entry, so the only level available is the top one - not "level 5 minus 5" of nothing.
    expect(entries[0].level).toBe(0);
  });

  it("measures the offset inside the scroll content, not on screen", () => {
    const root = host('<h2 id="md1-a">A</h2><h2 id="md1-b">B</h2>');
    const scroller = document.createElement("div");
    // The scroll position has to come back out of the rect difference, or the offset would describe
    // where a heading sits *right now* and every jump would land short by however far the reader has
    // already gone. Fixed rects here because this environment lays out nothing.
    Object.defineProperty(scroller, "scrollTop", { value: 40 });
    Object.defineProperty(scroller, "getBoundingClientRect", { value: () => ({ top: 0 }) });
    for (const [index, element] of Array.from(root.querySelectorAll("h2")).entries()) {
      Object.defineProperty(element, "getBoundingClientRect", { value: () => ({ top: 100 + index * 60 }) });
    }

    expect(collectMarkdownOutline(root, scroller).map((entry) => entry.offset)).toEqual([140, 200]);
    // Without a scroller there is nothing to measure against; jumping goes by id instead.
    expect(collectMarkdownOutline(root).map((entry) => entry.offset)).toEqual([100, 160]);
  });
});

describe("markdownHasHeadings", () => {
  it("answers the cheap question before anything is rendered", () => {
    expect(markdownHasHeadings("no headings here")).toBe(false);
    expect(markdownHasHeadings("## Setup")).toBe(true);
    expect(markdownHasHeadings("## Setup", 2)).toBe(false);
    expect(markdownHasHeadings("## A\n\n### B")).toBe(true);
    expect(markdownHasHeadings("# one\n## two\n### three", 4)).toBe(false);
  });
});
