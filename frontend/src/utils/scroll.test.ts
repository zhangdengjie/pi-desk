import { describe, expect, it } from "vitest";
import { isNearBottom, nextTailScroll } from "./scroll";

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
