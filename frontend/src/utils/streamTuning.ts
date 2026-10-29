import { reactive } from "vue";

/**
 * The two tunable groups of a streaming turn, in one reactive singleton.
 *
 * They come from `~/.pi-desk/config.json` (internal/userconfig), reach the store through
 * `ReadUserConfig`, and are read here by the renderer. A singleton instead of props on
 * purpose: these are pace numbers, not per-message state, and threading seven values
 * through ConversationPane → row → step → MarkdownBody would make every intermediate
 * component know about something it never renders.
 *
 * ⚠️ SHIPPED must equal Go's `DefaultReveal()` / `DefaultScroll()` in
 * internal/userconfig/config.go - the file is created from those, and the front end falls
 * back to these when the read fails. Keep the two in step.
 */
export type RevealMode = "plain" | "raw" | "markdown";

export interface RevealTuning {
  /**
   * What the growing tail is rendered as. `plain` is the typewriter: characters are
   * appended as text and nothing already painted moves, because no syntax reaches
   * backwards; closed blocks are still rendered as they close. `raw` goes one step
   * further and keeps the whole answer as text until the run settles, which removes
   * the one remaining re-layout - the hand-over of a closed block from source to
   * Markdown. `markdown` parses the tail every frame, which keeps formatting live but
   * re-flows lines when an inline marker closes and re-sizes a table as rows arrive.
   */
  mode: RevealMode;
  /** Each frame releases `backlog / split` characters. */
  split: number;
  /** Never reveal fewer than this per frame, so a trickle still moves. */
  floor: number;
  /** Never reveal more than this per frame, so one huge chunk cannot land whole. */
  ceiling: number;
}

export interface ScrollTuning {
  /** A jump no larger than this pins straight to the bottom. */
  snapWithinPx: number;
  /** Share of the remaining distance travelled per frame for a one-line gap. */
  factor: number;
  /** Gap at which the follow is back to the full share (a panel-sized jump). */
  catchUpPx: number;
  /** How close to a bottom - timeline or capped output window - re-arms the follow. */
  resumeWithinPx: number;
  /** How long a call must keep running before its output window opens on its own. */
  liveWindowDelayMs: number;
  /**
   * How long the live reasoning window takes to fold shut once the answer starts.
   * 0 closes it in the same frame, which is what the transcript used to do.
   */
  reasoningFoldMs: number;
}

export const SHIPPED: { reveal: RevealTuning; scroll: ScrollTuning } = {
  reveal: { mode: "plain", split: 20, floor: 2, ceiling: 60 },
  // `snapWithinPx` used to be 140, on the theory that a typing step moves the bottom by
  // "a couple of pixels". Measured against a real stream (dev tail probe, 2026-10-29): one line
  // of Markdown prose is 17-34px, so every line fell inside the snap band and the follow
  // pinned the bottom in a single step - `factor` was never once applied.
  //
  // 2026-10-30: the 4px band plus 0.32 per frame still moved a line in 3-4 frames, and the last
  // of those frames was the 3.8px snap - a larger step than the two before it. `factor` is now
  // the one-line share (~one frame per pixel, so a 22px line travels for the whole gap until
  // the next line) and `catchUpPx` hands the old
  // 0.32 back for panel-sized jumps. The band is down to sub-pixel rounding. See scroll.ts.
  scroll: { snapWithinPx: 2, factor: 0.005, catchUpPx: 160, resumeWithinPx: 24, liveWindowDelayMs: 1200, reasoningFoldMs: 0 },
};

export const streamTuning = reactive({
  reveal: { ...SHIPPED.reveal },
  scroll: { ...SHIPPED.scroll },
});

function number(value: unknown, fallback: number, low: number, high: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < low || parsed > high) return fallback;
  return parsed;
}

function revealMode(value: unknown, fallback: RevealMode): RevealMode {
  return value === "plain" || value === "raw" || value === "markdown" ? value : fallback;
}

/**
 * Copies what the config file says over the current tuning, rejecting anything out of
 * range per field instead of taking a half-broken object. The Go side clamps the same
 * way; this only protects against a failed read or an older build's payload.
 */
export function applyStreamTuning(
  reveal?: (Partial<Omit<RevealTuning, "mode">> & { mode?: string }) | null,
  scroll?: Partial<ScrollTuning> | null,
) {
  streamTuning.reveal.mode = revealMode(reveal?.mode, SHIPPED.reveal.mode);
  streamTuning.reveal.split = number(reveal?.split, SHIPPED.reveal.split, 2, 1000);
  streamTuning.reveal.floor = number(reveal?.floor, SHIPPED.reveal.floor, 1, 500);
  // A ceiling under the floor is not a slow reveal, it is a contradiction; the Go side
  // replaces the whole field with the shipped value, so do the same instead of inventing
  // a second rule here.
  const ceiling = number(reveal?.ceiling, SHIPPED.reveal.ceiling, 1, 100000);
  streamTuning.reveal.ceiling = ceiling < streamTuning.reveal.floor ? SHIPPED.reveal.ceiling : ceiling;
  streamTuning.scroll.snapWithinPx = number(scroll?.snapWithinPx, SHIPPED.scroll.snapWithinPx, 1, 10000);
  streamTuning.scroll.factor = number(scroll?.factor, SHIPPED.scroll.factor, 0.01, 0.99);
  streamTuning.scroll.catchUpPx = number(scroll?.catchUpPx, SHIPPED.scroll.catchUpPx, 32, 4000);
  streamTuning.scroll.resumeWithinPx = number(scroll?.resumeWithinPx, SHIPPED.scroll.resumeWithinPx, 1, 2000);
  streamTuning.scroll.liveWindowDelayMs = number(scroll?.liveWindowDelayMs, SHIPPED.scroll.liveWindowDelayMs, 0, 60000);
  // 0 is legal (fold off); only a negative or an absurdly slow fold is replaced.
  streamTuning.scroll.reasoningFoldMs = number(scroll?.reasoningFoldMs, SHIPPED.scroll.reasoningFoldMs, 0, 2000);
}

export function resetStreamTuning() {
  applyStreamTuning(null, null);
}
