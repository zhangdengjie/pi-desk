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
export interface RevealTuning {
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
  /** Share of the remaining distance travelled per frame while easing a larger jump. */
  factor: number;
  /** How close to a bottom - timeline or capped output window - re-arms the follow. */
  resumeWithinPx: number;
  /** How long a call must keep running before its output window opens on its own. */
  liveWindowDelayMs: number;
}

export const SHIPPED: { reveal: RevealTuning; scroll: ScrollTuning } = {
  reveal: { split: 5, floor: 2, ceiling: 160 },
  scroll: { snapWithinPx: 140, factor: 0.35, resumeWithinPx: 24, liveWindowDelayMs: 1200 },
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

/**
 * Copies what the config file says over the current tuning, rejecting anything out of
 * range per field instead of taking a half-broken object. The Go side clamps the same
 * way; this only protects against a failed read or an older build's payload.
 */
export function applyStreamTuning(reveal?: Partial<RevealTuning> | null, scroll?: Partial<ScrollTuning> | null) {
  streamTuning.reveal.split = number(reveal?.split, SHIPPED.reveal.split, 2, 1000);
  streamTuning.reveal.floor = number(reveal?.floor, SHIPPED.reveal.floor, 1, 500);
  // A ceiling under the floor is not a slow reveal, it is a contradiction; the Go side
  // replaces the whole field with the shipped value, so do the same instead of inventing
  // a second rule here.
  const ceiling = number(reveal?.ceiling, SHIPPED.reveal.ceiling, 1, 100000);
  streamTuning.reveal.ceiling = ceiling < streamTuning.reveal.floor ? SHIPPED.reveal.ceiling : ceiling;
  streamTuning.scroll.snapWithinPx = number(scroll?.snapWithinPx, SHIPPED.scroll.snapWithinPx, 1, 10000);
  streamTuning.scroll.factor = number(scroll?.factor, SHIPPED.scroll.factor, 0.01, 0.99);
  streamTuning.scroll.resumeWithinPx = number(scroll?.resumeWithinPx, SHIPPED.scroll.resumeWithinPx, 1, 2000);
  streamTuning.scroll.liveWindowDelayMs = number(scroll?.liveWindowDelayMs, SHIPPED.scroll.liveWindowDelayMs, 0, 60000);
}

export function resetStreamTuning() {
  applyStreamTuning(null, null);
}
