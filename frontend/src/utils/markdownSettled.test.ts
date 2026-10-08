import { describe, expect, it } from "vitest";
import { hasBackwardReference, seamNeedsSpacing, splitSettledMarkdown } from "./markdownSettled";
import { renderMarkdownDocument } from "./markdownRenderer";

/**
 * The contract under test is not "the splitter finds a nice place to cut". It is:
 *
 *   the HTML of the settled prefix must never change again.
 *
 * So every case is checked against the *real* renderer, one line at a time, the way
 * `utils/streamPacer.ts` grows a block. If any Markdown construct reaches backwards past a blank
 * line this module was willing to cut at, the property test at the bottom is where it shows up.
 *
 * ⚠️ That test was green for the wrong reason once already, and both mistakes are recorded here so
 * nobody re-introduces them:
 *   - the risky construct was the LAST thing in the fixture, so the boundary that would settle it
 *     never appeared while the document grew, and the hazard was never rendered;
 *   - the growth loop stopped at the last newline, so the final line was never a state at all.
 * Verified by disabling guards: with those two mistakes, all twelve fixtures stayed green with
 * every list and quote guard in the module commented out.
 */
function render(text: string): string {
  return renderMarkdownDocument(text, { slugCounts: new Map() }, "u", false);
}

function prose(paragraphs: number): string {
  const out: string[] = [];
  for (let index = 0; index < paragraphs; index += 1) {
    out.push(`Section ${index}: the quick brown fox jumps over the lazy dog, and then it explains a point in some detail for a while.`);
  }
  return out.join("\n\n");
}

/** Safe prose on both sides, so the risky construct is settled *during* the growth, not after it. */
function fixture(risky: string): string {
  return `${prose(30)}\n\n${risky}\n\n${prose(30)}`;
}

/** Every state the document passes through while it is being typed out. */
function growthPoints(text: string): number[] {
  const out = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    out.push(index + 1);
  }
  out.push(text.length);
  return out;
}

const FIXTURES: Record<string, string> = {
  "fenced code, closed": fixture("```ts\nconst a = 1;\n```"),
  "fenced code, never closed": fixture("```ts\nconst a = 1;\n\nthis line is inside the fence"),
  "ordered list split by a blank line": fixture("1. first\n\n2. second\n\n3. third"),
  "bullet list continuing after a blank line": fixture("- alpha\n\n  beta stays in the item\n\ngamma"),
  "nested list": fixture("- outer\n  - inner one\n\n  - inner two"),
  "blockquote pair, which really is two blocks": fixture("> quoted one\n\n> quoted two"),
  "lazy quote continuation": fixture("> quoted\nunquoted but still inside the quote"),
  "setext heading": fixture("a paragraph\n==="),
  "table then prose": fixture("| a | b |\n| --- | --- |\n| 1 | 2 |"),
  "pre-shaped text with a blank line inside": fixture("<pre>\none line\n\nstill inside the pre\n</pre>"),
  "link reference defined after its use": fixture("see [foo] for details.\n\n[foo]: https://example.com \"Foo\""),
  "brackets that are not definitions": fixture("use `[a]` in the config, and [b] is a range 1..9"),
  "headings and paragraphs": fixture("## Heading\n\nbody text\n### Another\n\nmore body"),
};

describe("splitSettledMarkdown", () => {
  const head = prose(30);

  it("refuses anything shorter than the floor", () => {
    expect(splitSettledMarkdown("one\n\ntwo\n\nthree")).toMatchObject({ settledLength: 0, reason: "too-short" });
  });

  it("reports each refusal by name", () => {
    // Asserted on the *intermediate* state - the moment the danger is live. Once the line after
    // the blank proves a construct is closed, settling it is correct, not a refusal.
    expect(splitSettledMarkdown(`${head}\n\n\`\`\`ts\nlet a = 1\n\nstill inside\n`)).toMatchObject({ reason: "open-fence" });
    expect(splitSettledMarkdown(`${head}\n\n1. one\n\n2. two\n`)).toMatchObject({ reason: "open-list" });
    expect(splitSettledMarkdown(`${head}\n\n- alpha\n\n  beta is indented\n`)).toMatchObject({ reason: "open-list" });
    expect(splitSettledMarkdown(`${head}\n\n[a]: https://e.com\n\n[a]\n\nplain after\n`)).toMatchObject({ reason: "reference-definition" });
    expect(splitSettledMarkdown("no blank lines at all\nand more\n")).toMatchObject({ reason: "no-boundary" });
  });

  it("settles the things it used to refuse on a wrong reading of CommonMark", () => {
    // An earlier revision refused a cut before `> two` and before anything after an open `<pre>`.
    // Both were wrong here: adjacent quoted paragraphs are two blockquotes, and with `html: false`
    // a `<pre>` line is just an escaped paragraph. Re-adding either guard would cost most of the
    // win on quoted prose for no safety, so this case is the tripwire.
    expect(splitSettledMarkdown(`${head}\n\n> one\n\n> two\n\nplain after\n`).reason).toBe("ok");
    expect(splitSettledMarkdown(`${head}\n\n<pre>\n\nstill open\n\nplain after\n`).reason).toBe("ok");
    expect(splitSettledMarkdown(`${head}\n\n1. one\n\nplain after\n`).reason).toBe("ok");
  });

  it("depends on the renderer being built with html:false", () => {
    // The reason `pre`/`script`/`textarea` need no guard is that this app escapes HTML in Markdown.
    // If that option is ever flipped, CommonMark's rule-1 html blocks come back (a blank line does
    // not end them) and this module's guard set is silently incomplete. This assertion is where
    // that consequence has to be read, and it fails at the source of the assumption.
    expect(render("<pre>\na\n\nb\n</pre>\n")).toContain("&lt;pre&gt;");
    expect(render("<pre>\na\n\nb\n</pre>\n")).not.toContain("<pre>");
  });

  it("settles a document whose blocks are all closed", () => {
    const split = splitSettledMarkdown(`${head}\n\na paragraph of prose\n\ntail paragraph\n`);
    expect(split.reason).toBe("ok");
    expect(split.tail.startsWith("tail paragraph")).toBe(true);
    expect(split.settled.endsWith("\n\n")).toBe(true);
  });

  it("cuts at the last boundary, not the first one", () => {
    expect(splitSettledMarkdown(`${head}\n\nmiddle\n\nlater\n\ntail\n`).settled).toContain("later");
  });

  it("treats a bracketed word in prose as harmless, and a definition line as not", () => {
    expect(hasBackwardReference(`${head}\n\n[a] is a range\n\nx`)).toBe(false);
    expect(hasBackwardReference(`${head}\n\n[a]: https://e.com\n\nx`)).toBe(true);
    // inside a fence a definition line is just text
    expect(hasBackwardReference(`${head}\n\n\`\`\`\n[a]: https://e.com\n\`\`\`\n\nx`)).toBe(false);
  });
});

describe("the settled prefix's HTML is final", () => {
  for (const [name, doc] of Object.entries(FIXTURES)) {
    it(name, () => {
      let settledSoFar = "";
      let htmlSoFar = "";
      let advances = 0;
      let refusals = 0;
      // The accumulation MarkdownBody.vue actually performs: append the render of the newly settled
      // source, carrying the heading counters across pieces. Asserting against that - not just
      // against "is it a prefix" - is what pins the component's equation, and it is what makes the
      // cost O(newly settled chars) instead of O(whole prefix) per block.
      let appended = "";
      let appendedChars = 0;
      let counters: [string, number][] = [];
      for (const cut of growthPoints(doc)) {
        const text = doc.slice(0, cut);
        const split = splitSettledMarkdown(text);
        if (!split.settledLength) {
          refusals += 1;
          continue;
        }
        const settled = text.slice(0, split.settledLength);
        // Monotone: the boundary may only ever move forward.
        if (settledSoFar) expect(settled.startsWith(settledSoFar)).toBe(true);
        const html = render(settled);
        // The whole point: growing the settled region must only ever append to what is on screen.
        if (htmlSoFar) {
          expect(html.startsWith(htmlSoFar)).toBe(true);
          advances += 1;
        }
        if (settledLengthAdvanced(settled, appendedChars)) {
          const counts = new Map(counters);
          appended += renderMarkdownDocument(settled.slice(appendedChars), { slugCounts: counts, preserveSlugs: true }, "u", false);
          appendedChars = settled.length;
          counters = [...counts.entries()];
        }
        settledSoFar = settled;
        htmlSoFar = html;
      }
      expect(settledSoFar.length).toBeGreaterThan(0);
      // The append-only path must land on exactly the same HTML as one whole pass over the final
      // settled region - otherwise the component's cheap route and the reference route disagree.
      expect(appended).toBe(render(settledSoFar));
      // Anti-vacuity: the prefix comparison has to have run several times, and the guards have to
      // have fired at least once - a fixture that settles every single step is not testing refusal.
      expect(advances).toBeGreaterThanOrEqual(3);
      expect(refusals).toBeGreaterThan(0);
    });
  }
});

function settledLengthAdvanced(settled: string, soFar: number): boolean {
  return settled.length > soFar;
}

describe("seamNeedsSpacing", () => {
  // A transcription of the four sibling selectors in styles/workbench.css. Each row is one of those
  // selectors (true) or a pair it deliberately does not cover (false).
  it.each([
    ["P", "P", true], ["UL", "P", true], ["OL", "P", true], ["PRE", "P", true],
    ["BLOCKQUOTE", "P", true], ["H1", "P", true], ["H2", "P", true], ["H4", "P", true],
    ["P", "UL", true], ["P", "OL", true], ["P", "PRE", true], ["P", "BLOCKQUOTE", true],
    // Not covered: a heading followed by a list gets its own margins, not the rhythm margin; two
    // lists are not a rhythm pair; and nothing on either side means there is no seam to space.
    ["H2", "UL", false], ["UL", "UL", false], ["OL", "OL", false], ["BLOCKQUOTE", "UL", false],
    ["H2", "H3", false], ["P", "H2", false], ["DIV", "P", false],
    [undefined, "P", false], ["P", undefined, false],
  ])("%s + %s -> %s", (before, after, expected) => {
    expect(seamNeedsSpacing(before, after)).toBe(expected);
  });
});
