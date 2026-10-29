import { describe, expect, it } from "vitest";
import { createSettleSnap, FULL_EASE_SHARE, isNearBottom, nextTailScroll, TAIL_PIN_OFFSET } from "./scroll";

describe("TAIL_PIN_OFFSET", () => {
  it("stays under the ceiling where WebKit drops a scrollTop write at the top", () => {
    // Measured in a real WKWebView: 2^31 - 1 lands at the bottom, 2^31 lands at 0.
    // Number.MAX_SAFE_INTEGER and Infinity both land at 0, so "just write something
    // huge" is a jump-to-top on the engine every macOS build runs on. Blink clamps the
    // same values correctly, which is what makes the bug invisible until someone opens
    // a session on macOS.
    expect(TAIL_PIN_OFFSET).toBeLessThan(2 ** 31);
    expect(Number.MAX_SAFE_INTEGER).toBeGreaterThanOrEqual(2 ** 31);
  });

  it("is finite, because both engines drop a non-finite write at the top", () => {
    expect(Number.isFinite(TAIL_PIN_OFFSET)).toBe(true);
  });

  it("is still far past the bottom of any transcript this pane can render", () => {
    // A million-screen session. The point of the constant is that the engine, not a
    // `scrollHeight` read, does the clamping.
    expect(TAIL_PIN_OFFSET).toBeGreaterThan(1_000_000 * 900);
  });
});

describe("isNearBottom", () => {
  it("sticks within the threshold and releases when reading older content", () => {
    expect(isNearBottom(704, 200, 1000)).toBe(true);
    expect(isNearBottom(650, 200, 1000)).toBe(false);
    expect(isNearBottom(700, 200, 1000, 100)).toBe(true);
  });
});

describe("nextTailScroll", () => {
  // 26px is one line of prose (dev tail probe, 2026-10-29: `h:26 t:26` step after step).
  // `scrollHeight - clientHeight` is the target, 703.
  const line = { top: 677, scrollHeight: 1000, clientHeight: 297 };

  it("spreads one line of growth over many frames instead of stepping to it", () => {
    let top = line.top;
    const steps: number[] = [];
    while (top < 703 && steps.length < 600) {
      const next = nextTailScroll(top, line.scrollHeight, line.clientHeight);
      steps.push(next - top);
      top = next;
    }
    // It does not have to land exactly: the next line arrives before the last couple of pixels
    // are worth chasing, and 2px is invisible. What matters is that it got there gradually.
    expect(top).toBeGreaterThan(700);
    // The old follow covered this in 3-4 frames: 8.3, 5.7, 3.9, 2.6, 1.8, then a 3.8px snap
    // that was larger than the two steps before it - a push per line, which is what the
    // reader called 跳动. Every frame now moves about a pixel.
    // At the shipped 0.5% per frame a 26px line is still travelling when the next line lands;
    // the point is that no single frame moves more than half a pixel, so the eye reads motion
    // rather than a step. (ConversationPane turns that into whole pixels - the engine drops
    // sub-pixel writes - which is one CSS pixel every 2-8 frames.)
    expect(steps.length).toBeGreaterThan(100);
    expect(steps.length).toBeLessThan(600);
    // The final write is the snap (up to the 2px band); every eased step is sub-pixel.
    expect(Math.max(...steps.slice(0, -1))).toBeLessThan(0.5);
  });

  it("gives the old share back for a panel-sized jump", () => {
    // A reasoning window releasing its fixed height: 600px in one frame. Easing that at the
    // one-line share would leave the newest content off screen for seconds.
    const next = nextTailScroll(200, 1000, 200);
    expect(next).toBeGreaterThan(200);
    expect(next).toBeLessThan(800);
    expect(next).toBeCloseTo(200 + 600 * FULL_EASE_SHARE, 0);
  });

  it("pins once the gap is sub-pixel", () => {
    expect(nextTailScroll(701.5, 1000, 297)).toBe(703);
  });

  it("converges on the bottom", () => {
    let top = 0;
    let frames = 0;
    while (top < 1400 && frames < 900) {
      top = nextTailScroll(top, 2000, 600);
      frames += 1;
    }
    expect(top).toBe(1400);
    expect(frames).toBeLessThan(900);
  });

  it("is frame-rate independent", () => {
    // Two 120Hz frames must cover what one 60Hz frame covers, or a ProMotion display would
    // halve the speed of every ease.
    const at60 = nextTailScroll(677, 1000, 297, 1, 0.04, 160, 1000 / 60);
    const half = nextTailScroll(677, 1000, 297, 1, 0.04, 160, 1000 / 120);
    const at120 = nextTailScroll(half, 1000, 297, 1, 0.04, 160, 1000 / 120);
    expect(at120).toBeCloseTo(at60, 1);
  });

  it("never moves backwards when the content shrinks", () => {
    // A panel closing leaves the browser clamped above the new bottom.
    expect(nextTailScroll(900, 1000, 300)).toBe(700);
  });
});

describe("createSettleSnap", () => {
  it("leaves the configured band alone until a run stops", () => {
    const snap = createSettleSnap(1200, () => 1_000);
    expect(snap.limit(140)).toBe(140);
  });

  it("makes the end-of-run batch pin in one frame instead of easing", () => {
    let clock = 1_000;
    const snap = createSettleSnap(1200, () => clock);
    snap.arm();
    // The window: a snap of Infinity sends nextTailScroll straight to the bottom.
    expect(snap.limit(140)).toBe(Number.POSITIVE_INFINITY);
    expect(nextTailScroll(200, 1000, 200, snap.limit(140))).toBe(800);
    // 600px in one frame would otherwise ease: 200 + 600 * the full share.
    expect(nextTailScroll(200, 1000, 200, 140, 0.04))
      .toBeCloseTo(200 + 600 * FULL_EASE_SHARE, 0);
    clock = 2_200;
    expect(snap.limit(140)).toBe(140);
  });

  it("re-arms on the next run so a second answer snaps too", () => {
    let clock = 0;
    const snap = createSettleSnap(500, () => clock);
    snap.arm();
    clock = 600;
    expect(snap.limit(140)).toBe(140);
    snap.arm();
    expect(snap.limit(140)).toBe(Number.POSITIVE_INFINITY);
  });

  it("expires at the boundary rather than one tick late", () => {
    let clock = 0;
    const snap = createSettleSnap(500, () => clock);
    snap.arm();
    clock = 500;
    expect(snap.limit(140)).toBe(140);
  });
});
