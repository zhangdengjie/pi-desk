import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { seamNeedsSpacing } from "../utils/markdownSettled";

/**
 * The streaming seam reproduces a CSS rule in TypeScript: `seamNeedsSpacing()` decides whether two
 * blocks that no longer share a parent would have been spaced by the paragraph-rhythm rule. That is
 * a transcription, and transcriptions drift. This test removes the parts that can drift and pins the
 * part that cannot be removed to the stylesheet it is supposed to mirror.
 *
 * Three guarantees, in the order they were earned:
 *
 *  1. **One owner of the number.** The gap is declared once as `--md-block-gap` and both the rhythm
 *     rule and the seam rule read it. This is not a convention - two dead copies of the same rule
 *     (9px here, 8px in `workbench.css`) sat in the tree for a long time, and the seam was written
 *     against the wrong one before a real WKWebView measurement caught it.
 *  2. **One owner of the pair set.** Exactly one rule in the stylesheets sets a top-level block gap
 *     via a sibling combinator. If a second appears, the seam predicate would have to know which one
 *     wins on the cascade, and no test can be trusted to encode that.
 *  3. **The predicate agrees with the rule.** Every (previous block, next block) tag pair is checked
 *     against the selectors parsed out of the stylesheet, not against a list typed into this file.
 *
 * `li + li` is deliberately out of scope: the seam only ever falls between top-level blocks, because
 * `utils/markdownSettled.ts` cuts at a blank line. A rule inside a list cannot be reached by it.
 */

const SHEETS = ["layout.css", "workbench.css", "tailwind.css", "tokens.css", "base.css"];
const TOP_LEVEL = ["P", "UL", "OL", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "TABLE", "HR"];

/** `/*`-comments carry most of the prose in these files and would otherwise be parsed as selectors. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Split a selector list on commas - but only the ones at depth 0. `:is(ul, ol, pre, blockquote)` is
 * one selector, and a naive `split(",") turns it into four, silently dropping the pairs the seam
 * rule is supposed to mirror.
 */
function splitSelectors(text: string): string[] {
  const out: string[] = [];
  let depth = 0, current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

interface BlockRule {
  selectors: string[];
  margin: string;
}

function rules(css: string): BlockRule[] {
  const found: BlockRule[] = [];
  const body = stripComments(css);
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const declaration = /(?:^|[;\s])margin-top:\s*([^;]+)/.exec(match[2]);
    if (!declaration) continue;
    found.push({ selectors: splitSelectors(match[1]), margin: declaration[1].trim() });
  }
  return found;
}

/** `.markdown-body p + :is(ul, ol)` -> [["P"], ["UL","OL"]]. Anything else returns null. */
function siblingPair(selector: string): [string[], string[]] | null {
  const prefixed = /\.markdown-body\s+(.+)$/.exec(selector);
  if (!prefixed) return null;
  const parts = prefixed[1].split("+").map((p) => p.trim());
  if (parts.length !== 2) return null;
  const sides = parts.map((side) => {
    const isList = /^:is\(([^)]*)\)$/.exec(side);
    const names = (isList ? isList[1] : side).split(",").map((t) => t.trim().toUpperCase());
    return names.every((t) => TOP_LEVEL.includes(t)) ? names : null;
  });
  return sides[0] && sides[1] ? [sides[0], sides[1]] : null;
}

// Read the way `workbench.test.ts` does - a path relative to vitest's cwd. `new URL(...,
// import.meta.url)` looks correct and is not: under the happy-dom environment the global `URL` is
// the DOM one, so it resolves against the page's base and hands back something that is not the
// stylesheet on disk. The parse then "succeeds" and finds nothing, which reads like a missing rule.
const sheets = await Promise.all(SHEETS.map((sheet) => readFile(`src/styles/${sheet}`, "utf8")));
const all = sheets.flatMap(rules);

const owners = all
  .map((rule) => ({
    rule,
    pairs: rule.selectors.flatMap((sel) => {
      const pair = siblingPair(sel);
      return pair ? pair[0].flatMap((b) => pair[1].map((a) => `${b}+${a}`)) : [];
    }),
  }))
  .filter((entry) => entry.pairs.length > 0);

it("has exactly one rule owning the top-level block gap", () => {
  expect(owners.map((o) => o.pairs)).toHaveLength(1);
});

describe("the gap is one number, referenced twice", () => {
  const declared = sheets.map(stripComments).join("\n").match(/--md-block-gap:/g);

  it("declares --md-block-gap once", () => {
    expect(declared).toHaveLength(1);
  });

  it("and both the rhythm rule and the seam rule read it instead of a literal", () => {
    expect(owners[0].rule.margin).toBe("var(--md-block-gap)");
    const seam = all.find((rule) => rule.selectors.some((s) => s.includes(".md-tail")));
    expect(seam?.margin).toBe("var(--md-block-gap)");
  });
});

describe("seamNeedsSpacing mirrors the stylesheet's pair set", () => {
  const expected = new Set(owners[0]?.pairs ?? []);

  it.each(TOP_LEVEL.flatMap((before) => TOP_LEVEL.map((after) => [before, after] as const)))(
    "%s + %s", (before, after) => {
      // A pair the rule does not name must stay unspaced, and one it does name must be spaced -
      // including the pairs the seam can never produce, so the predicate is not merely "close".
      expect(seamNeedsSpacing(before, after)).toBe(expected.has(`${before}+${after}`));
    });

  it("covers every pair the rule declares - the set is not silently smaller", () => {
    const covered = TOP_LEVEL.flatMap((b) => TOP_LEVEL.map((a) => `${b}+${a}`))
      .filter((key) => seamNeedsSpacing(...(key.split("+") as [string, string])));
    expect(new Set(covered)).toEqual(expected);
  });
});
