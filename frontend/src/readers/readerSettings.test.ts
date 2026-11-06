import { describe, expect, it } from "vitest";
import { DEFAULT_READER_SETTINGS, normalizeReaderSettings } from "./readerSettings";

/**
 * The settings blob is read back on every open, and it is user-editable text sitting in
 * `localStorage`. Everything unrecognised has to degrade to the default field by field rather than
 * throw, or one hand-edited value takes the readers down with it.
 */
describe("normalizeReaderSettings", () => {
  it("falls back to the defaults for a missing or empty blob", () => {
    expect(normalizeReaderSettings(undefined)).toEqual(DEFAULT_READER_SETTINGS);
    expect(normalizeReaderSettings({})).toEqual(DEFAULT_READER_SETTINGS);
  });

  it("keeps known values and drops unknown ones", () => {
    const settings = normalizeReaderSettings({ theme: "sepia", fontSize: 22, theme2: "x" });
    expect(settings.theme).toBe("sepia");
    expect(settings.fontSize).toBe(22);
    expect(settings).not.toHaveProperty("theme2");
  });

  it("clamps the numeric fields instead of trusting them", () => {
    expect(normalizeReaderSettings({ fontSize: 999 }).fontSize).toBe(30);
    expect(normalizeReaderSettings({ fontSize: 1 }).fontSize).toBe(12);
    expect(normalizeReaderSettings({ lineHeight: 9 }).lineHeight).toBe(2.4);
    // A NaN from `Number("abc")` must not poison the layout.
    expect(normalizeReaderSettings({ fontSize: "abc" }).fontSize).toBe(DEFAULT_READER_SETTINGS.fontSize);
  });

  it("rejects a theme the stylesheet does not define", () => {
    expect(normalizeReaderSettings({ theme: "neon" as never }).theme).toBe(DEFAULT_READER_SETTINGS.theme);
  });
});
