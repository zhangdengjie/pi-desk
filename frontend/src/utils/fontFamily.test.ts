import { describe, expect, it } from "vitest";
import { FONT_FAMILY_INPUT_MAX, sanitizeFontFamilyList } from "./fontFamily";

describe("sanitizeFontFamilyList", () => {
  it("quotes each name so a spaced family stays one family", () => {
    expect(sanitizeFontFamilyList("Helvetica Neue")).toBe('"Helvetica Neue"');
    expect(sanitizeFontFamilyList("  苹方-简 ")).toBe('"苹方-简"');
    // A comma is a fallback separator, not a character inside a name - the reader is allowed to bring
    // their own chain, and each link is quoted on its own so "Times, New Roman" cannot mean one family.
    expect(sanitizeFontFamilyList("Georgia,  Times   New Roman")).toBe('"Georgia", "Times New Roman"');
    expect(sanitizeFontFamilyList('Helvetica Neue, x"; color:red')).toBe('"Helvetica Neue", "x color:red"');
  });

  it("cannot be used to end the declaration and start another", () => {
    // The value is written onto the document root by App.vue, so a reader who typed any of these into
    // Settings > 字体 would otherwise be editing the stylesheet rather than choosing a font.
    // Note the first two: no comma, so they are a single name with the dangerous characters removed.
    // `:` survives on purpose - inside a quoted family name it is inert, and an allowlist would have
    // had to reject localised names to get there.
    expect(sanitizeFontFamilyList('x"; color: red; --y: "z')).toBe('"x color: red --y: z"');
    expect(sanitizeFontFamilyList("x}body{display:none}")).toBe('"xbodydisplay:none"');
    expect(sanitizeFontFamilyList("x\n\ty")).toBe('"xy"');
    expect(sanitizeFontFamilyList("@import url(evil)")).toBe('"import url(evil)"');
    expect(sanitizeFontFamilyList("a<b")).toBe('"ab"');
    expect(sanitizeFontFamilyList('a"; b: c; "d')).not.toContain(";");
    expect(sanitizeFontFamilyList("a}b{c")).not.toContain("}");
    expect(sanitizeFontFamilyList("a{b}")).not.toContain("{");
    // A breakout attempt that does bring its own comma still cannot leave the value it is quoted into.
    const forged = sanitizeFontFamilyList('a", b: c; "d');
    expect(forged).not.toContain(";");
    expect(forged.split(", ").every((part) => /^"[^"\\]*"$/.test(part))).toBe(true);
  });

  it("gives up when nothing usable is left", () => {
    expect(sanitizeFontFamilyList("")).toBe("");
    expect(sanitizeFontFamilyList("   ")).toBe("");
    expect(sanitizeFontFamilyList(";;;")).toBe("");
    expect(sanitizeFontFamilyList('""')).toBe("");
  });

  it("bounds what a pasted blob can do", () => {
    const many = Array.from({ length: 40 }, (_, i) => `F${i}`).join(", ");
    expect(sanitizeFontFamilyList(many).split(",")).toHaveLength(6);
    // The cap is on what the reader typed; the quotes are ours and bounded by MAX_PARTS, so the value
    // written onto the root is at most FONT_FAMILY_INPUT_MAX + 2 * MAX_PARTS long.
    const out = sanitizeFontFamilyList("A".repeat(500));
    expect(out.replace(/"/g, "")).toHaveLength(FONT_FAMILY_INPUT_MAX);
    expect(out.length).toBeLessThanOrEqual(FONT_FAMILY_INPUT_MAX + 2 * 6);
  });
});
