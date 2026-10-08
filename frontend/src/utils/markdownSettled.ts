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
  /** Why nothing may settle, or "ok". The last boundary seen is reported even when it was
   * refused, so a test can tell "no boundary exists" from "a boundary exists and I rejected it". */
  reason: SettledReason;
}

interface Line {
  /** Offset of the first character of the line. */
  start: number;
  /** Offset just past the line's newline, i.e. where the next line starts. */
  end: number;
  /** The line without its terminator. */
  body: string;
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
      if (start < text.length) out.push({ start, end: text.length, body: text.slice(start) });
      break;
    }
    out.push({ start, end: next + 1, body: text.slice(start, next) });
    start = next + 1;
  }
  return out;
}

function isBlank(line: Line): boolean {
  return line.body.trim() === "";
}

/**
 * The offset just past the last blank line whose following line is a legal cut, or -1.
 *
 * "Legal" is deliberately blunt about indentation: the line after the cut must start at column 0
 * and must not itself be a quote, a list marker or a raw-HTML opener. A line with any leading
 * whitespace could be a list item's continuation, a nested list, or an indented code block that
 * belongs to what came before, and telling those apart is exactly the work a block parser does -
 * which is the thing this module is trying not to repeat.
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

  const last = openAt.length;
  let candidate = -1;
  let candidateIndex = -1;
  for (let index = 0; index + 1 < last; index += 1) {
    if (!isBlank(rows[index])) continue;
    const next = rows[index + 1];
    // The cut lands at the start of the line *after* the blank, so the blank line itself goes
    // with the settled part: it carries no rendering of its own.
    if (!isBlank(next)) {
      candidate = next.start;
      candidateIndex = index;
    }
  }

  if (candidate < 0) return empty(fence ? "open-fence" : "no-boundary");
  if (sawDefinition) return empty("reference-definition");

  // Only the state a blank line cannot close is checked on the way out: a fence swallows
  // everything after it. A list is handled by the line *below*, which is the sound direction -
  // refusing on "a list was open above" is not safer, it just settles less.
  if (openAt[candidateIndex]) return empty("open-fence");

  // What the cut admits: the first line after it must be unable to reach back.
  const nextBody = rows[candidateIndex + 1].body;
  if (/^\s/.test(nextBody)) return empty("open-list");
  if (LIST_ITEM.test(nextBody)) return empty("open-list");

  if (candidate < MIN_SETTLED_CHARS) return empty("too-short");

  return {
    settledLength: candidate,
    settled: text.slice(0, candidate),
    tail: text.slice(candidate),
    reason: "ok",
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
