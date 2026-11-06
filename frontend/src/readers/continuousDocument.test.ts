import { afterEach, describe, expect, it, vi } from "vitest";
import { SPINE_ATTR, buildContinuousDocument, sectionIndexAt } from "./continuousDocument";

const sectionHtml = (body: string, extraHead = "", bodyAttributes = "") =>
  `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">`
  + `<head><title>t</title>${extraHead}</head><body${bodyAttributes}>${body}</body></html>`;

const stubSections = (htmls: (string | null)[]) => {
  const urls = htmls.map((html, index) => (html === null ? null : `blob:section-${index}`));
  const fetchMock = vi.fn(async (url: string) => {
    const index = Number(String(url).replace("blob:section-", ""));
    return { text: async () => htmls[index] ?? "" };
  });
  vi.stubGlobal("fetch", fetchMock);
  return htmls.map((_, index) => ({
    load: async () => urls[index],
  }));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildContinuousDocument", () => {
  it("keeps every spine item in order, with a wrapper each", async () => {
    const sections = stubSections([
      sectionHtml("<p>one</p>"),
      sectionHtml("<p>two</p>"),
      sectionHtml("<p>three</p>"),
    ]);
    const html = await buildContinuousDocument(sections);
    const doc = new DOMParser().parseFromString(html, "application/xhtml+xml");

    const wrappers = Array.from(doc.querySelectorAll(`section[${SPINE_ATTR}]`));
    expect(wrappers.map((el) => el.getAttribute(SPINE_ATTR))).toEqual(["0", "1", "2"]);
    expect(wrappers.map((el) => el.textContent)).toEqual(["one", "two", "three"]);
  });

  it("hoists each section's stylesheet into the shared head", async () => {
    const sections = stubSections([
      sectionHtml("<p>a</p>", '<link rel="stylesheet" href="blob:css-a"/>'),
      sectionHtml("<p>b</p>", "<style>p{color:red}</style>"),
    ]);
    const html = await buildContinuousDocument(sections);
    expect(html).toContain('href="blob:css-a"');
    expect(html).toContain("p{color:red}");
    expect(html.indexOf("blob:css-a")).toBeLessThan(html.indexOf(`<section ${SPINE_ATTR}="0"`));
  });

  it("carries body attributes over, since books scope their rules on them", async () => {
    const sections = stubSections([sectionHtml("<p>a</p>", "", ' class="chapter" epub:type="bodymatter"')]);
    const html = await buildContinuousDocument(sections);
    expect(html).toContain(`<section ${SPINE_ATTR}="0"`);
    expect(html).toContain('class="chapter"');
    expect(html).toContain('epub:type="bodymatter"');
  });

  // A failed section must not shift the indices of the ones after it.
  it("keeps a placeholder for a section that fails to load", async () => {
    const sections = stubSections([sectionHtml("<p>a</p>"), null, sectionHtml("<p>c</p>")]);
    const html = await buildContinuousDocument(sections);
    const doc = new DOMParser().parseFromString(html, "application/xhtml+xml");
    const wrappers = Array.from(doc.querySelectorAll(`section[${SPINE_ATTR}]`));
    expect(wrappers.map((el) => el.getAttribute(SPINE_ATTR))).toEqual(["0", "1", "2"]);
    expect(wrappers[1].textContent).toBe("");
    expect(wrappers[2].textContent).toBe("c");
  });

  it("starts with an uppercase DOCTYPE so the XML parser accepts it", async () => {
    // A lowercase `<!doctype` is a parse error in XML: the whole merged document degrades to a
    // single `parsererror` node and the reader shows an empty page (found in the WKWebView probe;
    // jsdom is lenient about it, hence the string assertion).
    const html = await buildContinuousDocument(stubSections([sectionHtml("<p>a</p>")]));
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.toLowerCase().startsWith("<!doctype")).toBe(true);
  });

  it("keeps epub:type in its namespace so footnote rules still select it", async () => {
    const sections = stubSections([
      sectionHtml('<aside epub:type="footnote"><p>note</p></aside>'),
    ]);
    const html = await buildContinuousDocument(sections);
    const doc = new DOMParser().parseFromString(html, "application/xhtml+xml");
    // The namespace itself is the serializer's job; what this module must not do is drop the
    // attribute. jsdom's XML parser does not inherit prefixes from an ancestor, so the NS lookup is
    // asserted in the WKWebView probe instead.
    expect(html).toContain('epub:type="footnote"');
    expect(doc.querySelector("parsererror")).toBeNull();
  });
});

describe("sectionIndexAt", () => {
  const doc = new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>`
    + `<section ${SPINE_ATTR}="0"><p>a</p></section>`
    + `<section ${SPINE_ATTR}="1"><div><p id="target">b</p></div></section>`
    + `</body></html>`,
    "application/xhtml+xml",
  );

  it("walks up from a text node to its wrapper", () => {
    const text = doc.getElementById("target")?.firstChild ?? null;
    expect(sectionIndexAt(text)).toBe(1);
  });

  it("walks up from an element", () => {
    expect(sectionIndexAt(doc.getElementById("target"))).toBe(1);
  });

  it("returns undefined outside every wrapper", () => {
    expect(sectionIndexAt(doc.body)).toBeUndefined();
    expect(sectionIndexAt(null)).toBeUndefined();
  });
});