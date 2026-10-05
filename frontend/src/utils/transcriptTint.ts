// The maths behind Settings > 外观 > 对话底色.
//
// The tint is mixed into the theme's own ground by `color-mix` in tokens.css, which is the right
// place for it - but a mix interpolates LIGHTNESS as well as hue, so a reader who picks a dark
// colour in the light theme (or a pale one in the dark theme) drags the answer's ground toward their
// swatch and, past some point, under their own `--text`. A strength cap alone cannot stop that: the
// dangerous percentage depends on how far the picked colour sits from the ground, which is only
// known once the reader has picked it.
//
// So the picked colour is re-anchored here before it reaches CSS: keep its hue, keep most of its
// chroma, but put its lightness back near the theme's own ground. `--transcript-tint-strength` can
// then run to 100% because the mixed result cannot leave the ground's lightness band by much, no
// matter what was picked.
//
// Why this is TypeScript and not CSS: `oklch(from var(--transcript-tint) …)` - relative color
// syntax reading a custom property - is rejected by the engine this app renders in. Measured in the
// real WKWebView (`.pi/bin/mdshot`, MDSHOT_JS): the literal form `oklch(from #c98b3a 0.18 0.04 80)`
// computes fine, the same expression with `from var(--t)` falls back to the previous declaration.
// So the anchor has to be computed before it is written onto the root.

export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * The lightness of each theme's own transcript ground, in oklab. Mirrors `--transcript-tint-anchor`
 * in tokens.css (a contract test in tokens.test.ts pins the two together) and is used from App.vue
 * rather than read off the element, because the tint watch and the theme watch fire on the same
 * appearance change.
 */
export const TRANSCRIPT_TINT_ANCHOR = { light: 0.9871, dark: 0.18 } as const;

// How much of the picked colour's own lightness is allowed to survive the anchor. 0 would make a
// grey pick invisible (it lands exactly on the ground), which reads as "the setting does nothing";
// this small pull is what makes 灰调 legible while keeping the mixed ground inside the readable
// band for `--text` in both themes.
const LIGHTNESS_PULL = 0.18;

// A saturated pick at full strength is a field of colour, not a background. Chroma is bounded so the
// wash stays a wash; below the bound the pick's own saturation is honoured.
const MAX_CHROMA = 0.06;

export type Oklch = { l: number; c: number; h: number };

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const gamma = channel <= 0.0031308 ? channel * 12.92 : 1.055 * (channel ** (1 / 2.4)) - 0.055;
  return Math.min(1, Math.max(0, gamma));
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  const lms = [
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  ].map((channel) => Math.cbrt(channel));
  const l = 0.2104542553 * lms[0] + 0.7936177850 * lms[1] + 0.0040720468 * lms[2];
  const a = 1.9779984951 * lms[0] - 2.4285922050 * lms[1] + 0.4505937099 * lms[2];
  const bb = 0.0259040371 * lms[0] + 0.7827717662 * lms[1] - 0.8086757660 * lms[2];
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return { l, c: Math.sqrt(a * a + bb * bb), h: hue < 0 ? hue + 360 : hue };
}

export function oklchToHex({ l, c, h }: Oklch): string {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const lms = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.2914855480 * b,
  ].map((channel) => channel ** 3);
  const rgb = [
    4.0767416627 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097538175 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.7076147010 * lms[2],
  ].map(linearToSrgb);
  const to255 = (channel: number) => Math.round(channel * 255);
  return `#${rgb.map((channel) => to255(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG relative luminance, straight from the hex the compositor will paint. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/**
 * The colour that actually goes into `--transcript-tint`: the reader's hue, a bounded chroma, and the
 * theme's own lightness (nudged a little toward the pick so greys still register). Written as a
 * literal `oklch()` because that is the form the engine accepts.
 */
export function anchorOklch(hex: string, anchorLightness: number): Oklch {
  const { l, c, h } = hexToOklch(hex);
  const anchored = anchorLightness + (l - anchorLightness) * LIGHTNESS_PULL;
  // oklch lightness is 0..1 and chroma is unbounded in the spec but ~0.01..0.33 in practice.
  return { l: Math.min(1, Math.max(0, anchored)), c: Math.min(MAX_CHROMA, c), h };
}

export function anchoredTranscriptTint(hex: string, anchorLightness: number): string {
  if (!HEX_COLOR_PATTERN.test(hex)) return "";
  const { l, c, h } = anchorOklch(hex, anchorLightness);
  return `oklch(${l.toFixed(4)} ${c.toFixed(4)} ${h.toFixed(2)})`;
}

/**
 * What the ground ends up as after `color-mix(in oklab, ground calc(100% - s), tint)`: oklab is
 * linear in each channel along the connecting line, so the mix is a weighted mean of the endpoints.
 * Kept here so the contrast guard can be computed rather than asserted by eye.
 */
export function mixOklch(ground: Oklch, tint: Oklch, tintShare: number): Oklch {
  const share = Math.min(1, Math.max(0, tintShare));
  // Hue is angular: take the short way round, which is what `oklab` does.
  let dh = tint.h - ground.h;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return {
    l: ground.l + (tint.l - ground.l) * share,
    c: ground.c + (tint.c - ground.c) * share,
    h: (ground.h + dh * share + 360) % 360,
  };
}
