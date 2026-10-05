// Settings > 外观 > 字体 can name any family the machine has. Three facts about the engine this app
// renders in, all measured in the real WKWebView (`.pi/bin/mdshot` with MDSHOT_JS), are why it is a
// typed name and not a dropdown:
//
// - `document.fonts.size` is `0`. The CSS Font Loading API only knows `@font-face` faces, never the
//   system's, so there is nothing to list.
// - `window.queryLocalFonts` is `undefined` - that one is Chromium-only, and it asks permission even
//   there.
// - `document.fonts.check('12px "Nope Not A Font"')` returns **true**, so even "does this family
//   exist" cannot be answered; a wrong name falls back silently.
//
// What is left is a text field, a live preview line as the only feedback the reader gets, and a
// fallback chain that keeps the shipped stack when the name is not installed. This module owns the one
// thing that is not a matter of taste: whatever the reader types becomes a CSS value, so it must stop
// being able to end that declaration and start another.

// Characters that can close a declaration, open a block, start an at-rule, or escape a quoted family
// name. A denylist rather than an ASCII allowlist on purpose: family names are localised ("苹方-简",
// "Hiragino Sans GB"), and a name is worth no more than the value it cannot forge.
const UNSAFE = /["'\\;{}<>@`[\u0000-\u001f]/g;

export const FONT_FAMILY_INPUT_MAX = 160;
const MAX_PARTS = 6;

/**
 * Turn reader input into a `font-family` value: each comma-separated name is stripped of the
 * characters that could break out of the value, trimmed, collapsed, quoted, and rejoined. Returns ""
 * when nothing usable is left, which is how callers fall back to the shipped stack.
 */
export function sanitizeFontFamilyList(input: string): string {
  return input
    .slice(0, FONT_FAMILY_INPUT_MAX)
    .split(",")
    .map((part) => part.replace(UNSAFE, "").replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0)
    .slice(0, MAX_PARTS)
    .map((part) => `"${part}"`)
    .join(", ");
}
