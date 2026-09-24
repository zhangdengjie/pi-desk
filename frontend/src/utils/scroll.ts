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
 * A typing step moves the bottom by a couple of pixels, and pinning straight to it is
 * what a smooth run looks like. What is *not* smooth is a discrete jump - a reasoning
 * window releasing its fixed height, an image finishing decoding, a fenced block
 * closing - where the exact pin throws the whole screen in one frame. Anything past
 * `snapWithin` therefore travels a fraction of the remaining distance per frame, which
 * reads as the tail being caught up with rather than teleported to.
 *
 * The target is `scrollHeight`, not a clamped offset: content keeps growing underneath,
 * and always aiming at the newest bottom is what stops the ease from lagging behind.
 */
export function nextTailScroll(
  currentTop: number,
  scrollHeight: number,
  clientHeight: number,
  // Read per call, not captured at module load: a hand edit to the config file takes
  // effect on the next frame without a restart.
  snapWithin = streamTuning.scroll.snapWithinPx,
  factor = streamTuning.scroll.factor,
): number {
  const distance = scrollHeight - clientHeight - currentTop;
  if (distance <= snapWithin) return scrollHeight;
  return currentTop + Math.max(1, distance * factor);
}
