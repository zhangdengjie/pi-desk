import { isNearBottom } from "./scroll";
import { streamTuning } from "./streamTuning";

/**
 * Tail-follow for a scroll container *inside* the conversation - a running tool's output
 * window, the live reasoning window. Those are height-capped, so a long output stops
 * growing the row and the timeline has nothing left to follow: the newest characters
 * simply fall off the bottom of that inner box and stay there.
 *
 * `attachInnerTail` returns the controller; callers write content then call `step()`.
 */
export interface InnerTail {
  /** Pin to the newest line, unless the reader scrolled up inside this box. */
  step: () => void;
  /** Force the follow off (a run that is no longer live, a new tool call). */
  stop: () => void;
  /** Whether it is still following. */
  isArmed: () => boolean;
  /** Drop the listeners; the element is going away. */
  destroy: () => void;
}

/** How far from the bottom counts as "the reader came back" (see streamTuning). */
export function attachInnerTail(element: HTMLElement, resumeWithin = streamTuning.scroll.resumeWithinPx): InnerTail {
  let armed = true;

  function onScroll() {
    // Our own writes land exactly on the bottom, so this can only go false because of
    // the reader. No need to tell the two apart the way the timeline does.
    armed = isNearBottom(element.scrollTop, element.clientHeight, element.scrollHeight, resumeWithin);
  }

  function onWheel(event: WheelEvent) {
    // Some engines deliver wheel before the scroll event; releasing here means the next
    // step() cannot undo the reader's upward flick.
    if (event.deltaY < 0) armed = false;
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "PageUp" || event.key === "ArrowUp" || event.key === "Home") armed = false;
  }

  element.addEventListener("scroll", onScroll, { passive: true });
  element.addEventListener("wheel", onWheel, { passive: true });
  element.addEventListener("keydown", onKeyDown);

  return {
    step() {
      if (armed) element.scrollTop = element.scrollHeight;
    },
    stop() {
      armed = false;
    },
    isArmed: () => armed,
    destroy() {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("keydown", onKeyDown);
    },
  };
}
