import { describe, expect, it } from "vitest";
import { createSettleSnap, isNearBottom, nextTailScroll } from "./scroll";

describe("isNearBottom", () => {
  it("sticks within the threshold and releases when reading older content", () => {
    expect(isNearBottom(704, 200, 1000)).toBe(true);
    expect(isNearBottom(650, 200, 1000)).toBe(false);
    expect(isNearBottom(700, 200, 1000, 100)).toBe(true);
  });
});

describe("nextTailScroll", () => {
  it("pins straight to the bottom for a typing step", () => {
    // 3px of new text is what one animation frame of a revealed answer looks like.
    expect(nextTailScroll(700, 1000, 297)).toBe(1000);
  });

  it("eases a jump instead of teleporting the screen", () => {
    // A reasoning window releasing its fixed height: 600px in one frame.
    const next = nextTailScroll(200, 1000, 200);
    expect(next).toBeGreaterThan(200);
    expect(next).toBeLessThan(1000);
    expect(next).toBeCloseTo(410, 0);   // 200 + 600 * 0.35
  });

  it("converges on the bottom within a few frames", () => {
    let top = 0;
    for (let frame = 0; frame < 12; frame += 1) top = nextTailScroll(top, 2000, 600);
    expect(top).toBe(2000);
  });

  it("never moves backwards when the content shrinks", () => {
    // A panel closing leaves the browser clamped above the new bottom.
    expect(nextTailScroll(900, 1000, 300)).toBe(1000);
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
    expect(nextTailScroll(200, 1000, 200, snap.limit(140))).toBe(1000);
    // 600px in one frame would otherwise ease: 200 + 600 * 0.35.
    expect(nextTailScroll(200, 1000, 200, 140)).toBeCloseTo(410, 0);
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
