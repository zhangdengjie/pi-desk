/**
 * Where a growing Markdown document may be cut into a part that is already final and a part that
 * can still change.
 *
 * Why this exists at all: a streamed answer is revealed a frame at a time
 * (`utils/streamPacer.ts`), and the renderer replaces the whole block on every one of those steps
 * (`components/MarkdownBody.vue` renders `v-html`). So revealing n characters in k steps costs
 * O(n*k) work, not O(n) - the per-frame cost is proportional to everything already on screen.
 * Cutting the document in two puts a ceiling on that: everything above the cut is parsed once and
 * never touched again, and only the tail is re-rendered per frame.
 *
 * The contract, and it is deliberately narrow:
 *
 *   `splitSettledMarkdown(text).settled` is a prefix whose rendered HTML is **final** - appending
 *   anything to `text` can never change it.
 *
 * That is only true because of what this module refuses to settle. Everything below is one of
 * those refusals, and each one exists because Markdown has constructs that reach *backwards* from
 * text that has not arrived yet:
 *
 *   - an unclosed fence swallows every later line;
 *   - `1. a` + blank + `2. b` is one list, and rendering the two halves apart restarts the
 *     numbering - and makes the items loose instead of tight - so the `<ol>` the reader already saw
 *     would be replaced by a different one;
 *   - a line indented by any amount after the blank could be a list item's continuation;
 *   - a link reference definition resolves references **anywhere earlier in the document**
 *     (markdown-it collects them in a prepass), so one definition line arriving late can rewrite
 *     HTML that looked finished.
 *
 * The last one is why a document containing any definition outside a fence settles *not at all*,
 * rather than carrying an "invalidated" flag: definitions are rare in prose a model writes, the
 * fallback is exactly what the app does today, and a stateless predicate is much harder to get
 * wrong than an invalidation protocol.
 *
 * Two hazards this file used to guard against turned out not to exist, and the guards went:
 *
 *   - `> one` + blank + `> two` is **two** blockquotes, and rendering them apart is byte-identical
 *     (CommonMark, and verified against this renderer). Refusing there cost most of the win on
 *     quoted prose and bought nothing.
 *   - `<pre>` … blank … `</pre>` is the one HTML block a blank line cannot close - but the
 *     renderer is built with `html: false` (`utils/markdownRenderer.ts`), so those lines are
 *     escaped paragraphs and a blank line closes them like any other. The dependency is pinned by
 *     a test in `markdownSettled.test.ts` instead of by dead branches: flip `html` to true and that
 *     test fails here, which is where the consequence needs to be read.
 *
 * What is *not* a hazard, and therefore not refused: setext underlines and table delimiter rows
 * must directly follow the line they modify, so a blank line already disarms them; and a table
 * cannot continue across a blank line.
 */

/** Below this the two-pass render costs more than it saves: one lookup, one extra node, and a
 * tail that is probably the whole answer anyway. */
export const MIN_SETTLED_CHARS = 2_000;

export type SettledReason =
  | "ok"
  | "too-short"
  | "no-boundary"
  | "open-fence"
  | "open-list"
  | "reference-definition";

export interface SettledSplit {
  /** `text.slice(0, settledLength)` has final HTML. 0 means "render the whole thing". */
  settledLength: number;
  settled: string;
  tail: string;
  /** Why the *final* boundary could not be used, or "ok" if it could. Settling can still happen at
   * an earlier boundary while this says e.g. "open-fence" - that is the prose above the fence. */
  reason: SettledReason;
}

interface Line {
  /** Offset of the first character of the line. */
  start: number;
  /** Offset just past the line's newline, i.e. where the next line starts. */
  end: number;
  /** The line without its terminator. */
  body: string;
  /** False for the last line while the document is still being written and has no newline yet. */
  terminated: boolean;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(\s|$)/;
const REFERENCE_DEFINITION = /^ {0,3}\[([^\]]*)\]:\s/;

function lines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const next = text.indexOf("\n", start);
    if (next < 0) {
      if (start < text.length) out.push({ start, end: text.length, body: text.slice(start), terminated: false });
      break;
    }
    out.push({ start, end: next + 1, body: text.slice(start, next), terminated: true });
    start = next + 1;
  }
  return out;
}

function isBlank(line: Line): boolean {
  return line.body.trim() === "";
}

/**
 * The last blank-line boundary whose cut is safe, plus a diagnosis of why the *final* one is not.
 *
 * Two rules shape the search:
 *
 *   - The line after the cut must be **terminated**. An in-progress line can still turn into a
 *     continuation of what is above it (`1` becomes `1. item`), and a cut in front of it would then
 *     have to move backwards. Requiring the newline makes a boundary's safety immutable once
 *     granted, which is what keeps the settled region monotone while the document grows.
 *   - The line after the cut must start at column 0 and must not be a list marker. A line with any
 *     leading whitespace could be a list item's continuation, a nested list, or an indented code
 *     block belonging to what came before, and telling those apart is exactly the work a block
 *     parser does - which is the thing this module is trying not to repeat.
 *
 * Boundaries are walked from the end backwards instead of "take the last one or give up": inside an
 * open fence the last boundary is illegal, and giving up there would refuse to settle the prose
 * *above* the fence - which is most of what a streaming code answer contains. The fence's own
 * contents stay in the tail until it closes.
 */
export function splitSettledMarkdown(text: string): SettledSplit {
  const rows = lines(text);
  const empty = (reason: SettledReason): SettledSplit => ({ settledLength: 0, settled: "", tail: text, reason });

  // One pass over the lines, tracking the only state that can reach backwards.
  let fence: { marker: string; length: number } | null = null;
  let sawDefinition = false;
  // Per-line snapshots, so a candidate boundary can ask "was a fence open just before me?".
  const openAt: boolean[] = [];

  for (const row of rows) {
    openAt.push(fence !== null);

    const fenceMatch = FENCE.exec(row.body);
    if (fence) {
      // A closing fence is the same character, at least as long, and nothing else on the line.
      if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length
        && row.body.slice(fenceMatch[0].length).trim() === "") {
        fence = null;
      }
      continue; // nothing inside a fence is structure, including the definition scan
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }

    if (!sawDefinition && !isBlank(row) && REFERENCE_DEFINITION.test(row.body)) sawDefinition = true;
  }

  const reject = (index: number): SettledReason => {
    // A definition anywhere in the document can resolve a reference anywhere above it, and the
    // reference may already be settled. Rare in prose a model writes; the fallback is what the app
    // does today, and it is much harder to get wrong than an invalidation protocol.
    if (sawDefinition) return "reference-definition";
    // A fence swallows everything after its opener, so a cut inside one is not a block boundary.
    if (openAt[index]) return "open-fence";
    const body = rows[index].body;
    if (/^\s/.test(body)) return "open-list";
    if (LIST_ITEM.test(body)) return "open-list";
    return "ok";
  };

  // The diagnosis of the final legal cut point, reported even when an earlier boundary was used,
  // so a caller can tell "a fence is open" from "there is no blank line yet".
  let reason: SettledReason = fence ? "open-fence" : "no-boundary";
  let settledLength = -1;
  let final = true;
  for (let index = rows.length - 1; index >= 1; index -= 1) {
    const row = rows[index];
    // A cut lands at the start of a terminated, non-blank line that follows a blank one.
    if (isBlank(row) || !row.terminated || !isBlank(rows[index - 1])) continue;
    const why = reject(index);
    if (final) {
      reason = why;
      final = false;
    }
    if (why === "ok") {
      settledLength = row.start;
      break;
    }
  }

  if (settledLength < 0) return empty(reason);
  if (settledLength < MIN_SETTLED_CHARS) return empty("too-short");

  return {
    settledLength,
    settled: text.slice(0, settledLength),
    tail: text.slice(settledLength),
    reason,
  };
}

/** Exposed for the property test: does this text contain a construct that forbids settling. */
export function hasBackwardReference(text: string): boolean {
  let fence: { marker: string; length: number } | null = null;
  for (const row of lines(text)) {
    const match = FENCE.exec(row.body);
    if (fence) {
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length
        && row.body.slice(match[0].length).trim() === "") fence = null;
      continue;
    }
    if (match) {
      fence = { marker: match[1][0], length: match[1].length };
      continue;
    }
    if (!isBlank(row) && REFERENCE_DEFINITION.test(row.body)) return true;
  }
  return false;
}
