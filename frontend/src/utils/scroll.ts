/**
 * An offset that means "the very bottom" without reading layout.
 *
 * The usual trick for pinning a scroll box is to write something absurd and let the
 * engine clamp it. On WebKit that trick backfires above 2^31 through the *property
 * setter*: `element.scrollTop = 2147483648` is dropped at 0, i.e. straight to the top,
 * while `element.scrollTo(0, 2147483648)` clamps correctly. Measured on both engines
 * with `.pi/bin/hitprobe/scroll-battery.html` (`scrollprobe` for WKWebView - the one
 * every macOS build ships on - and headless Chrome for Blink):
 *
 * | write to `scrollTop` | WebKit | Blink |
 * |---|---|---|
 * | `1e9`, `2^31 - 1`, `2^30` | bottom | bottom |
 * | `2^31`, `2^32`, `Number.MAX_SAFE_INTEGER` | **top** | bottom |
 * | `Infinity`, `1e300`, `-1e9`, `NaN` | top | top |
 *
 * So `Number.MAX_SAFE_INTEGER` was never "the bottom" here - it is a teleport to the
 * top plus a scroll event the follow then reads as "the reader left the tail", which
 * disarms the pin mid-run. And no non-finite value is a safe alternative: both engines
 * drop those at 0, so the only portable oversized write is a finite one under 2^31.
 *
 * 1e9 keeps the property the oversized write was there for - no `scrollHeight` read,
 * so no forced layout of the transcript - and sits 2x under the ceiling. The pane
 * would need about a million screens of content before the write stops reaching the
 * bottom.
 */
export const TAIL_PIN_OFFSET = 1_000_000_000;

export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 96): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * True when a gesture landed on (or inside) a nested scroll container that can
 * still move upward on its own — a long reasoning block, a tool output, a code
 * fence. In that case the outer transcript has not moved yet, so the caller
 * must not read the gesture as "the reader left the tail".
 */
export function nestedScrollerCanGoUp(target: EventTarget | null, outer: Element | null | undefined): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== outer) {
    if (node.scrollTop > 0 && node.scrollHeight - node.clientHeight > 1) return true;
    node = node.parentElement;
  }
  return false;
}

import { streamTuning } from "./streamTuning";

/**
 * Where the transcript tail should sit on the next frame while it is being followed.
 *
 * A typing step moves the bottom by one line, and a line of Markdown prose is 17-34px tall
 * (measured 2026-10-29 with the dev tail probe: `h:26 t:26` step after step). That is not
 * "a couple of pixels", so a band wide enough to cover it pins the bottom in one step on
 * every line, and `factor` is never applied - which reads as the transcript jumping once per
 * line rather than scrolling. The band is therefore only wide enough for sub-pixel noise, and
 * a line's growth travels a fraction of the remaining distance per frame: caught up with, not
 * teleported to. What the ease is really for is the discrete jump - a reasoning window
 * releasing its fixed height, an image finishing decoding, a fenced block closing - where an
 * exact pin would throw the whole screen in one frame.
 *
 * The target is `scrollHeight - clientHeight`, not an oversized offset: content keeps growing
 * underneath, and always aiming at the newest bottom is what stops the ease from lagging.
 */
/**
 * The share of the gap the follow covers per 60fps frame for a gap of one line.
 *
 * A line of prose is 17-34px and it lands as a *step*, not as growth: the browser only
 * re-flows when the line breaks, so the tail is still for a second or two and then the
 * document is 26px taller in one frame. Easing that 26px in 3-4 frames is a 8px jump
 * followed by a 5px, a 3px and a final snap that is *larger* than the step before it -
 * the reader sees the screen being pushed once per line. At 0.5% per frame the same 22px is
 * still travelling when the next line lands: one CSS pixel every 2-8 frames, measured on the
 * sandbox WKWebView (dev follow probe, 2026-10-30), which reads as the text scrolling.
 *
 * The cost is lag: a continuously growing tail sits about a line behind the bottom. The
 * transcript's 24px bottom padding absorbs it, so the newest line stays fully visible.
 *
 * The value itself lives in `streamTuning.scroll.factor` (0.5% shipped) so a hand edit to
 * `~/.pi-desk/config.json` can retune it without a rebuild.
 */

/**
 * The gap at which the follow is allowed to use the full share again.
 *
 * The slow share above is only right for a line. A reasoning window collapsing, an image
 * decoding or a fenced block closing moves the bottom by hundreds of pixels at once, and
 * easing that at 0.5% per frame would leave the newest content off screen for a second.
 * The share ramps up with the square of `gap / CATCH_UP_PX`, so a one-line step stays
 * slow while a panel-sized step is chased at the old pace.
 */
export const CATCH_UP_PX = 160;

/** The share used at and past `CATCH_UP_PX` - the value `factor` used to be everywhere. */
export const FULL_EASE_SHARE = 0.32;

/**
 * Smallest step the control law may ask for.
 *
 * Sub-pixel steps do not survive the engine: a 0.78px write came back as 0 for five frames in
 * a row on the sandbox WKWebView (dev follow probe, 2026-10-30: the gap fell 4px over 25
 * frames while the control law asked for 0.78px per frame), which is why the tail used to sit
 * 18px behind. The caller therefore accumulates the fractional step and writes whole pixels
 * (`pendingStep` in ConversationPane). This floor only keeps the request non-zero.
 */
const MIN_STEP_PX = 0.01;

export function nextTailScroll(
  currentTop: number,
  scrollHeight: number,
  clientHeight: number,
  // Read per call, not captured at module load: a hand edit to the config file takes
  // effect on the next frame without a restart.
  snapWithin = streamTuning.scroll.snapWithinPx,
  factor = streamTuning.scroll.factor,
  catchUpPx = streamTuning.scroll.catchUpPx,
  // The frame interval, so the same time constant holds on a 120Hz display. The default
  // is one 60fps frame; callers that can measure it should pass the real one.
  dtMs = 1000 / 60,
): number {
  const target = scrollHeight - clientHeight;
  const distance = target - currentTop;
  // `<=` also covers a shrinking document: the engine has already clamped scrollTop to
  // the new bottom, and the follow must not ease upward through content that no longer
  // exists (that is the "content got shorter" shake, not a scroll).
  if (distance <= snapWithin) return target;
  const ramp = Math.min(1, distance / Math.max(1, catchUpPx));
  // `factor` above the full share is a deliberate "always fast" setting; the ramp must not
  // slow a large gap below it.
  const full = Math.max(FULL_EASE_SHARE, factor);
  const share = factor + (full - factor) * ramp * ramp;
  // Frame-rate independent: `share` is defined per 60fps frame, so a 120Hz frame must
  // cover the fraction of it that one 60Hz frame's worth of time buys.
  const alpha = 1 - Math.pow(1 - share, dtMs / (1000 / 60));
  const step = Math.max(MIN_STEP_PX, distance * alpha);
  // Never overshoot: a step past the target would be read back as "content shrank" and
  // bounce for a frame.
  return currentTop + Math.min(step, distance);
}

/**
 * The short window right after a run stops, where the follow pins instead of easing.
 *
 * Easing exists for a *mid-stream* discrete jump: one block lands and the tail is
 * caught up with over a few frames, which reads as motion rather than a teleport.
 * The end of a run is the opposite shape. Three batches of height land within a couple
 * of frames of each other - `agent_end` collapsing the execution panels and inserting
 * the changed-files card, then `agent_settled` replacing the transcript rows with their
 * persisted versions, then the repository refresh - and their signs disagree (panels
 * shrink, the card grows). Easing that batch spreads several hundred pixels of motion
 * over a dozen frames *while the height is still changing*, so the ease overshoots and
 * reverses between frames: that is the shake a reader sees at the end of an answer,
 * not at the beginning.
 *
 * So the batch snaps, and only the batch: the window is armed on the live-to-idle edge
 * and expires on its own. The reader keeps every escape hatch - the follow still
 * releases on an upward wheel, and past the window the easing is exactly what it was.
 */
export function createSettleSnap(durationMs: number, now: () => number = Date.now) {
  let until = 0;
  return {
    /** A run just stopped (`streaming` true -> false). */
    arm() {
      until = now() + durationMs;
    },
    /**
     * The `snapWithin` to hand `nextTailScroll`: unbounded inside the window, the
     * configured band outside it.
     */
    limit(snapWithin: number) {
      return now() < until ? Number.POSITIVE_INFINITY : snapWithin;
    },
  };
}

export type SettleSnap = ReturnType<typeof createSettleSnap>;
