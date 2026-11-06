/**
 * Renders a reflowable EPUB as one continuous column flow instead of one iframe per spine item.
 *
 * foliate pages a book by loading a single section into an iframe and columnising it. A section
 * that is shorter than one spread (a part title page, a chapter opener) therefore leaves the second
 * column empty — the page looks half-rendered next to Apple Books, which flows the whole book. The
 * only way to get the same result is to hand the paginator one document that contains every
 * section, in order.
 *
 * Two things make this safe:
 *
 * - `Loader.loadReplaced` has already rewritten every `src` / `href` / inline `url()` into a blob
 *   URL before `section.load()` resolves, so a section's markup is self-contained. Concatenating
 *   bodies needs no URL rewriting.
 * - Each section keeps its own `<section data-spine="i">` wrapper, and its body children are copied
 *   verbatim. That is what lets a CFI produced against the merged document resolve again: the path
 *   `/4/4/2/1` is identical in both, and only the spine half (`/6/4!`) has to come from the real
 *   section. Nothing has to be rewritten — see `sectionIndexAt`.
 */

import { EPUB_CSP } from "../utils/foliateCsp";

/** Attribute that maps a node back to the spine item it came from. */
export const SPINE_ATTR = "data-spine";

export interface ContinuousSection {
  load?: () => Promise<string | null | undefined>;
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * XHTML keeps `epub:type` in its namespace, which the reader's footnote rules select on
 * (`aside[epub|type~="endnote"]`). Parsing a section as HTML would silently drop that, so XML is
 * tried first and HTML is only the fallback for books that are not well-formed.
 */
const parseSection = (text: string): Document => {
  const xml = new DOMParser().parseFromString(text, "application/xhtml+xml");
  if (!xml.querySelector("parsererror")) return xml;
  return new DOMParser().parseFromString(text, "text/html");
};

/**
 * Builds the merged document. Every section keeps a wrapper, including ones that failed to load, so
 * `data-spine` always equals the index in `book.sections`.
 */
export async function buildContinuousDocument(
  sections: readonly ContinuousSection[],
): Promise<string> {
  const serializer = new XMLSerializer();
  const bodies: string[] = [];
  const styles: string[] = [];

  for (const [index, section] of sections.entries()) {
    // `xmlns:epub` on the wrapper, not only on the root: `XMLSerializer` emits `<aside epub:type>`
    // without its own declaration, and a parser that does not inherit prefixes from the root (jsdom
    // does not) would drop the namespace the footnote rules select on.
    const wrapper = `<section ${SPINE_ATTR}="${index}" xmlns:epub="http://www.idpf.org/2007/ops"`;
    let url: string | null | undefined = null;
    try {
      url = await section.load?.();
    } catch {
      url = null;
    }
    if (!url) {
      bodies.push(`${wrapper}></section>`);
      continue;
    }
    const doc = parseSection(await (await fetch(url)).text());
    for (const el of Array.from(doc.querySelectorAll("style, link[rel~='stylesheet']"))) {
      styles.push(serializer.serializeToString(el));
    }
    const attributes = Array.from(doc.body?.attributes ?? [])
      .filter((attribute) => attribute.name !== "xmlns")
      .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
      .join("");
    const content = Array.from(doc.body?.childNodes ?? [])
      .map((node) => serializer.serializeToString(node))
      .join("");
    bodies.push(`${wrapper}${attributes}>${content}</section>`);
  }

  return [
    // Uppercase: XML is case sensitive and `<!doctype` is a parse error, which turns the whole
    // merged document into a `parsererror` node.
    "<!DOCTYPE html>",
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">',
    '<head><meta charset="utf-8"/>',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(EPUB_CSP)}"/>`,
    // A chapter starts a new page, not a new line: without this the part title page and the first
    // chapter title run on in the same column. The paginator's columns are the page boxes here, so
    // a forced column break is exactly a page break.
    `<style>section[${SPINE_ATTR}] + section[${SPINE_ATTR}]`
      + "{ break-before: column; -webkit-column-break-before: always; }</style>",
    ...styles,
    "</head><body>",
    ...bodies,
    "</body></html>",
  ].join("");
}

/** The spine item a node belongs to, or `undefined` when it is outside every wrapper. */
export const sectionIndexAt = (node: Node | null | undefined): number | undefined => {
  let element: Element | null = node
    ? (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)
    : null;
  while (element) {
    const value = element.getAttribute?.(SPINE_ATTR);
    if (value != null) {
      const index = Number(value);
      return Number.isInteger(index) ? index : undefined;
    }
    element = element.parentElement;
  }
  return undefined;
};

/**
 * The node "go to the start of section N" should scroll to. Not the wrapper itself: in a column
 * layout a multi-column block's bounding box starts at its first column but the browser reports a
 * union rect, which lands on the wrong page. The first child is a single element and has a clean
 * rect.
 */
export const sectionStartNode = (doc: Document, index: number): Node | null => {
  const wrapper = doc.querySelector(`[${SPINE_ATTR}="${index}"]`);
  return wrapper?.firstElementChild ?? wrapper;
};

/** Which wrapper a CFI's anchor points at, used when restoring a saved position. */
export const sectionIndexAtRange = (range: Range | null | undefined): number | undefined =>
  range ? sectionIndexAt(range.startContainer) : undefined;