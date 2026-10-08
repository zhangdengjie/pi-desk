import { describe, expect, it } from "vitest";
import { renderMarkdownDocument } from "./markdownRenderer";
import { MIN_SETTLED_CHARS, splitSettledMarkdown } from "./markdownSettled";

/**
 * What one revealed frame makes the parser read.
 *
 * While an answer streams, the component's job is to put one more chunk on screen per frame. The
 * old route re-rendered the entire block to do it, so the *last* frame of a long answer was the most
 * expensive thing on screen - which is exactly the frame the reader is watching, and exactly the
 * frame that drops when the tab has a backlog to land after a resume.
 *
 * The number that matters is therefore not the total, it is `worst`: the characters read in a single
 * frame. The new route keeps that at "the live tail plus whatever just settled", no matter how long
 * the answer already is.
 *
 * This is a cost regression test, not a benchmark: a change that quietly puts the whole-prefix parse
 * back on the per-frame path fails here with the numbers attached.
 */
function answer(paragraphs: number): string {
  const parts: string[] = [];
  for (let index = 0; index < paragraphs; index += 1) {
    parts.push(`Paragraph ${index}: the quick brown fox jumps over the lazy dog while the platform reports a status code, a latency figure and a short note about both of them.`);
  }
  parts.push("## Setup\n\n- install the agent\n- run the migration");
  parts.push("```ts\nconst a = 1;\nconst b = a + 1;\n```");
  parts.push("## Setup\n\nthe second heading shares the slug");
  return parts.join("\n\n");
}

interface Cost {
  /** Characters handed to the parser across the whole reveal. */
  chars: number;
  /** Characters handed to the parser in its single most expensive frame. */
  worst: number;
  ms: number;
}

/** The reveal step `utils/streamTuning.ts` allows at its ceiling: 160 chars per frame. */
const FRAME_CHARS = 160;

function render(text: string, slugCounts: Map<string, number>, preserveSlugs: boolean): void {
  renderMarkdownDocument(text, { slugCounts, preserveSlugs }, "u", false);
}

/** One frame of the old path: the whole block, every time. */
function revealWholeDocument(text: string): Cost {
  const start = performance.now();
  let chars = 0;
  let worst = 0;
  for (let shown = FRAME_CHARS; shown <= text.length; shown += FRAME_CHARS) {
    render(text.slice(0, shown), new Map(), false);
    chars += shown;
    worst = Math.max(worst, shown);
  }
  return { chars, worst, ms: performance.now() - start };
}

/**
 * One frame of the new path, mirroring `components/MarkdownBody.vue`: append the newly settled
 * source, re-render the tail, carry the heading counters across pieces.
 */
function revealSplit(text: string): Cost {
  const start = performance.now();
  let chars = 0;
  let worst = 0;
  let settledChars = 0;
  let counters = new Map<string, number>();
  for (let shown = FRAME_CHARS; shown <= text.length; shown += FRAME_CHARS) {
    const source = text.slice(0, shown);
    const split = splitSettledMarkdown(source);
    let frame = 0;
    if (split.settledLength >= settledChars) {
      if (split.settledLength > settledChars) {
        const slugCounts = new Map(counters);
        render(source.slice(settledChars, split.settledLength), slugCounts, true);
        frame += split.settledLength - settledChars;
        settledChars = split.settledLength;
        counters = slugCounts;
      }
      render(split.tail, new Map(counters), true);
      frame += split.tail.length;
    } else {
      // Refused: below the floor there is nothing settled yet, so the block renders whole.
      render(source, new Map(), false);
      frame += source.length;
    }
    chars += frame;
    worst = Math.max(worst, frame);
  }
  return { chars, worst, ms: performance.now() - start };
}

describe("streaming reveal cost", () => {
  const lengths = [20, 60, 150].map((paragraphs) => answer(paragraphs));

  it("bounds one frame by the tail, not by the length of the answer", () => {
    const results = lengths.map((text) => ({ text, whole: revealWholeDocument(text), split: revealSplit(text) }));
    for (const { text, whole, split } of results) {
      // The old path's worst frame is the last one: the entire answer, parsed again.
      expect(whole.worst).toBe(Math.floor(text.length / FRAME_CHARS) * FRAME_CHARS);
      // Never more work than the old path, and much less as the answer grows (asserted below).
      expect(split.chars).toBeLessThan(whole.chars);
    }
    // The invariant, stated directly: an answer seven times as long must not cost a longer frame.
    // The frame that crosses MIN_SETTLED_CHARS is the cliff - below it nothing is settled and the
    // block renders whole - so the ceiling is the floor plus a reveal step and a tail line.
    const worst = results.map((result) => result.split.worst);
    expect(new Set(worst).size).toBe(1);
    expect(worst[0]).toBeLessThanOrEqual(MIN_SETTLED_CHARS + 3 * FRAME_CHARS);
    // And the saving grows with the answer, because settled characters stop being re-read.
    const ratios = results.map((result) => result.whole.chars / result.split.chars);
    expect(ratios[1]).toBeGreaterThan(ratios[0]);
    expect(ratios[2]).toBeGreaterThan(ratios[1]);
    // A short answer barely benefits: the floor is 2k and the answer is 3k. That is the design -
    // below the floor there is nothing to keep, and re-rendering a small block whole is cheap.
    expect(ratios[0]).toBeGreaterThan(1.5);
    expect(ratios[2]).toBeGreaterThan(20);
    for (const { text, whole, split } of results) {
      // eslint-disable-next-line no-console
      console.log(`  ${text.length} chars: worst frame ${whole.worst} -> ${split.worst}, `
        + `total parsed ${whole.chars} -> ${split.chars} (${(whole.chars / split.chars).toFixed(1)}x), `
        + `${whole.ms.toFixed(0)}ms -> ${split.ms.toFixed(0)}ms`);
    }
  });

  it("still settles the prose above a fence that has not closed", () => {
    // The shape a coding assistant's answer is actually made of. An open fence cannot settle, so its
    // contents are re-read every frame - but everything above it is not, and that is most of the
    // document. Without the backwards boundary search this case settled nothing at all.
    const text = `${answer(60)}\n\n\`\`\`ts\n${"const line = 1;\n".repeat(400)}\n// the fence never closes`;
    const whole = revealWholeDocument(text);
    const split = revealSplit(text);
    expect(text.length).toBeGreaterThan(15_000);
    expect(split.worst).toBeLessThan(whole.worst / 2);
    expect(split.chars).toBeLessThan(whole.chars / 4);
    // eslint-disable-next-line no-console
    console.log(`  ${text.length} chars with an open fence: worst frame ${whole.worst} -> ${split.worst}, `
      + `total parsed ${whole.chars} -> ${split.chars} (${(whole.chars / split.chars).toFixed(1)}x)`);
  });
});
