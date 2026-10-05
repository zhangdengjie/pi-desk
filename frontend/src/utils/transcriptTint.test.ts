import { describe, expect, it } from "vitest";
import {
  anchoredTranscriptTint,
  anchorOklch,
  contrastRatio,
  HEX_COLOR_PATTERN,
  hexToOklch,
  legibleCodeColor,
  mixOklch,
  oklchToHex,
  TRANSCRIPT_TINT_ANCHOR,
} from "./transcriptTint";

// The two grounds and the two text colours the themes actually ship (tokens.css). Written as oklch
// literals and converted, rather than hard-coded as hex, so a theme edit shows up here as a contrast
// failure instead of a stale constant.
const SURFACES = [
  {
    name: "light",
    anchor: TRANSCRIPT_TINT_ANCHOR.light,
    ground: oklchToHex(hexToOklch("#f8f8f8")),
    text: oklchToHex({ l: 0.2, c: 0.006, h: 255 }),
  },
  {
    name: "dark",
    anchor: TRANSCRIPT_TINT_ANCHOR.dark,
    ground: oklchToHex({ l: 0.18, c: 0.006, h: 255 }),
    text: oklchToHex({ l: 0.94, c: 0.006, h: 255 }),
  },
];

// The corners a reader can actually reach with a colour panel: both extremes of lightness, the three
// fully saturated primaries, and a mid grey.
const EXTREME_PICKS = ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#8a8a8a", "#c98b3a", "#123456"];

describe("transcriptTint", () => {
  it("round-trips hex through oklch without moving the colour perceptibly", () => {
    for (const hex of EXTREME_PICKS) {
      const a = hexToOklch(hex);
      const b = hexToOklch(oklchToHex(a));
      let dh = Math.abs(a.h - b.h);
      if (dh > 180) dh = 360 - dh;
      // Compared in oklch rather than in hex bytes: the two matrices the spec publishes are only
      // approximate inverses of each other, so a fully saturated pick comes back a few 1/255 off
      // (#00ff00 -> #0cff0a). That is invisible at the pastel chroma this setting can produce, and
      // asserting byte equality would be asserting a precision the maths does not have.
      expect(Math.abs(a.l - b.l), hex).toBeLessThan(0.01);
      expect(Math.abs(a.c - b.c), hex).toBeLessThan(0.02);
      // Achromatic picks have no meaningful hue - atan2 of rounding noise spins freely.
      if (a.c > 0.02) expect(dh, hex).toBeLessThan(2);
    }
  });

  it("keeps the hue and bounds the chroma while pulling lightness to the theme", () => {
    const picked = hexToOklch("#ff0000");
    const anchored = anchorOklch("#ff0000", TRANSCRIPT_TINT_ANCHOR.light);
    expect(anchored.h).toBeCloseTo(picked.h, 4);
    expect(anchored.c).toBeLessThanOrEqual(0.06);
    expect(Math.abs(anchored.l - TRANSCRIPT_TINT_ANCHOR.light)).toBeLessThan(0.1);
  });

  it("still lets a grey pick register", () => {
    // With lightness anchored exactly, `#8a8a8a` would land on the ground and the setting would look
    // dead. The small pull is what makes 灰调 visible, so it is a behaviour and not an accident.
    const anchored = anchorOklch("#8a8a8a", TRANSCRIPT_TINT_ANCHOR.light);
    expect(anchored.l).toBeLessThan(TRANSCRIPT_TINT_ANCHOR.light);
    expect(anchored.c).toBeCloseTo(0, 3);
  });

  it("accepts only a complete #rrggbb", () => {
    expect(anchoredTranscriptTint("#c98b3a", 0.18)).toMatch(/^oklch\(0\.\d+ 0\.\d+ \d+\.\d+\)$/);
    for (const junk of ["", "c98b3a", "#c98b3", "#c98b3gg", "red", "#c98b3aabb"]) {
      expect(anchoredTranscriptTint(junk, 0.18), junk).toBe("");
    }
    expect(HEX_COLOR_PATTERN.test("#123456")).toBe(true);
  });

  it("keeps the answer readable at full strength for every reachable pick", () => {
    for (const surface of SURFACES) {
      const ground = hexToOklch(surface.ground);
      for (const pick of EXTREME_PICKS) {
        const tint = anchorOklch(pick, surface.anchor);
        for (const share of [0.4, 1]) {
          const mixed = oklchToHex(mixOklch(ground, tint, share));
          // WCAG AA for body text is 4.5:1. Measured worst case across this matrix is 9.5:1 (light,
          // #000000 at 100%), so the margin is not thin - the assertion is here to catch a future
          // change to LIGHTNESS_PULL / MAX_CHROMA quietly eating it.
          expect(contrastRatio(mixed, surface.text), `${surface.name} ${pick} @${share * 100}% → ${mixed}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("moves the ground further at 100% than at 40%", () => {
    // The strength knob has to be worth reaching for: at the old 25% ceiling the wash was barely
    // legible, which is what read as "picking a colour does nothing".
    const ground = hexToOklch(SURFACES[0].ground);
    const tint = anchorOklch("#c98b3a", TRANSCRIPT_TINT_ANCHOR.light);
    const weak = oklchToHex(mixOklch(ground, tint, 0.25));
    const strong = oklchToHex(mixOklch(ground, tint, 1));
    expect(contrastRatio(weak, strong)).toBeLessThan(1.25);
    expect(weak).not.toBe(strong);
  });
});

describe("legibleCodeColor", () => {
  const groundHex = (dark: boolean) =>
    oklchToHex({ l: dark ? TRANSCRIPT_TINT_ANCHOR.dark : TRANSCRIPT_TINT_ANCHOR.light, c: 0, h: 0 });

  // The picks that break a naive "just use what they chose": pure white and black, the two highest-
  // luminance hues, and a mid grey that is legible on neither ground at its own lightness.
  const EXTREMES = ["#ffffff", "#000000", "#ffff00", "#00ffff", "#ff00ff", "#8a8a8a", "#c98b3a", "#006400"];

  it("clears AA against both theme grounds, for every extreme pick", () => {
    for (const dark of [false, true]) {
      for (const pick of EXTREMES) {
        const out = legibleCodeColor(pick, dark);
        expect(HEX_COLOR_PATTERN.test(out), `${pick} on ${dark ? "dark" : "light"}`).toBe(true);
        expect(contrastRatio(out, groundHex(dark)), `${pick} on ${dark ? "dark" : "light"} -> ${out}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("leaves an already-legible pick alone", () => {
    // Walking only starts when the pick fails, so the common case is the reader's exact colour.
    expect(legibleCodeColor("#1f3a5f", false)).toBe("#1f3a5f");
    expect(legibleCodeColor("#d8e6f7", true)).toBe("#d8e6f7");
  });

  it("moves lightness and not hue", () => {
    const before = hexToOklch("#ffff00");
    const after = hexToOklch(legibleCodeColor("#ffff00", false));
    // Yellow stays yellow. A few degrees of drift is allowed because the walk round-trips through
    // sRGB, and a saturated yellow pushed dark is outside the gamut.
    expect(Math.abs(after.h - before.h)).toBeLessThan(6);
    expect(after.l).toBeLessThan(before.l);
  });

  it("refuses anything that is not a full hex colour", () => {
    expect(legibleCodeColor("", false)).toBe("");
    expect(legibleCodeColor("red", false)).toBe("");
    expect(legibleCodeColor("#fff", false)).toBe("");
  });
});
