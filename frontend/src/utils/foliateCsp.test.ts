import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyFoliateCsp, isFoliateEpub } from "./foliateCsp";

/**
 * The rewrite is a source patch against a third-party file, so the useful test is "does it still
 * match the installed foliate-js?" — a literal fixture would keep passing after an upstream bump
 * while the real loader silently fell back to unsanitized markup.
 */
const installedEpubSource = () => readFileSync(
  resolve(process.cwd(), "node_modules/foliate-js/epub.js"),
  "utf8",
);

describe("applyFoliateCsp", () => {
  it("matches the installed foliate-js loader", () => {
    const result = applyFoliateCsp(installedEpubSource());
    expect(result.skipped).toEqual([]);
    expect(result.applied).toHaveLength(1);
  });

  it("strips active content and injects the CSP before serialization", () => {
    const result = applyFoliateCsp(installedEpubSource());
    expect(result.code).toContain("Content-Security-Policy");
    expect(result.code).toContain("querySelectorAll('script')");
    expect(result.code).toContain('meta[http-equiv="refresh" i], base');
    expect(result.code).toContain("startsWith('on')");
    // The patch must replace exactly one serialization point, not merely append code after it.
    expect(result.code).not.toContain("TODO: replace inline scripts");
    expect(result.code.indexOf("querySelectorAll('script')"))
      .toBeLessThan(result.code.indexOf("new XMLSerializer().serializeToString(doc)"));
  });

  it("leaves unrelated sources untouched", () => {
    const source = "export const x = 1\n";
    const result = applyFoliateCsp(source);
    expect(result.code).toBe(source);
    expect(result.skipped).toHaveLength(1);
    expect(result.applied).toHaveLength(0);
  });
});

describe("isFoliateEpub", () => {
  it("recognises the loader with or without a Vite query string", () => {
    expect(isFoliateEpub("/repo/frontend/node_modules/foliate-js/epub.js")).toBe(true);
    expect(isFoliateEpub("/repo/frontend/node_modules/foliate-js/epub.js?v=1")).toBe(true);
    expect(isFoliateEpub("C:\\repo\\frontend\\node_modules\\foliate-js\\epub.js")).toBe(true);
  });

  it("does not claim the paginator", () => {
    expect(isFoliateEpub("/repo/frontend/node_modules/foliate-js/paginator.js")).toBe(false);
    expect(isFoliateEpub("/repo/frontend/node_modules/foliate-js/view.js")).toBe(false);
  });
});
