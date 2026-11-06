import { describe, expect, it } from "vitest";
import { applySafari15Rewrites, hasRegexLookbehind } from "./safari15Compat";

/** The exact expression foliate-js ships in `paginator.js` (the reason this module exists). */
const foliateSource = "detail.data = data.replace(/(?<=[{\\s;])-epub-/gi, '').replace(/(\\d*\\.?\\d+)vw/gi, x)";

describe("applySafari15Rewrites", () => {
  it("removes the lookbehind foliate-js uses to strip -epub- prefixes", () => {
    const result = applySafari15Rewrites(foliateSource);
    expect(hasRegexLookbehind(result.code)).toBe(false);
    expect(result.applied).toHaveLength(1);
    expect(result.code).toContain(".replace(/([{\\s;])-epub-/gi, '$1')");
  });

  it("keeps the semantics: identical output to the lookbehind it replaces", () => {
    // Node supports lookbehind, so the original expression can be run side by side with the
    // rewrite instead of asserted from memory. A leading `-epub-` is deliberately not stripped by
    // either: the lookbehind only fires after `{`, whitespace or `;`.
    const original = /(?<=[{\s;])-epub-/gi;
    const rewritten = /([{\s;])-epub-/gi;
    const rewriteOriginal = (text: string) => text.replace(original, "");
    const rewritePatched = (text: string) => text.replace(rewritten, "$1");

    for (const sample of [
      "p { -epub-font-size: 1em }",
      "a{-epub-hyphens:auto;-epub-line-break:normal}",
      "-epub-hyphens: auto",
      "  -epub-text-align-last: left",
      "x; -epub-font-variant: small-caps; y",
    ]) {
      expect(rewritePatched(sample)).toBe(rewriteOriginal(sample));
    }
  });

  it("leaves unrelated sources untouched and reports nothing applied", () => {
    const source = "const value = list.at(-1) ?? 0;";
    const result = applySafari15Rewrites(source);
    expect(result.code).toBe(source);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it("detects any remaining lookbehind so a missed rewrite fails loudly", () => {
    expect(hasRegexLookbehind("/(?<!x)y/")).toBe(true);
    expect(hasRegexLookbehind("/(?<name>x)/")).toBe(false);
  });
});
