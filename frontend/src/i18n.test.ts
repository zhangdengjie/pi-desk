import { describe, expect, it } from "vitest";
import { i18n } from "./i18n";

/**
 * Every string the UI shows has to exist twice, by hand, in two object literals 600 lines apart —
 * and `tr(key)` takes a plain string, so a typo or a language added on one side only fails at
 * runtime, in whichever locale the reader is not looking at. These three checks are the type
 * checker that dictionary does not get: same key tree both sides, no empty value, same
 * `{placeholder}` set per key.
 */

type Message = Record<string, unknown>;

function flatten(message: Message, prefix = ""): Array<[string, string]> {
  return Object.entries(message).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null) return flatten(value as Message, path);
    return [[path, String(value)]];
  });
}

const locale = (language: "en" | "zh-CN") => flatten(i18n.global.getLocaleMessage(language) as Message);
const en = locale("en");
const zh = locale("zh-CN");
const placeholders = (value: string) => (value.match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g) ?? []).sort();

describe("i18n dictionaries", () => {
  it("declares the same keys in both languages", () => {
    const enKeys = en.map(([path]) => path);
    const zhKeys = zh.map(([path]) => path);
    expect(zhKeys.filter((key) => !enKeys.includes(key))).toEqual([]);
    expect(enKeys.filter((key) => !zhKeys.includes(key))).toEqual([]);
    expect(enKeys.length).toBeGreaterThan(400);
  });

  it("keeps every value non-empty", () => {
    expect([en, zh].flat().filter(([, value]) => !value.trim()).map(([path]) => path)).toEqual([]);
  });

  it("passes the same interpolation arguments to both languages", () => {
    const zhValues = new Map(zh);
    const drifted = en
      .filter(([path, value]) => String(placeholders(zhValues.get(path) ?? "")) !== String(placeholders(value)))
      .map(([path]) => path);
    expect(drifted).toEqual([]);
  });
});
