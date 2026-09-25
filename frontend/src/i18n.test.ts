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

/**
 * The dictionaries are the easy half. The hard half is a component that never asks for a key and
 * just puts `aria-label="Clear terminal"` or `title="刷新"` in the template - it renders, in the wrong
 * language, for the other half of the readers, and nothing fails. Upstream's inspector refactor did
 * exactly that twice in three weeks, so the sweep that fixed it is now the test:
 * no commented-out literal survives.
 */
const sources = {
  ...(import.meta.glob("./components/*.vue", { query: "?raw", import: "default", eager: true }) as Record<string, string>),
  ...(import.meta.glob("./App.vue", { query: "?raw", import: "default", eager: true }) as Record<string, string>),
};

// Product names and sample values, not prose. Anything added here needs a reason in the entry.
const LITERALS_ALLOWED = new Set([
  "Pi Desk", // product name
  "openai-custom", "my-mcp-server", "npx", "code-review", // placeholder examples: literal ids a reader may paste
]);

function withoutComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // `//` only starts a comment when it is not part of a `://` URL.
    .replace(/(?<![:])\/\/[^\n]*/g, "");
}

describe("no untranslated literals in components", () => {
  it("keeps static labels out of the templates", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      const hits = withoutComments(source).matchAll(/(?:^|[^:\w-])(aria-label|title|placeholder|label)="([A-Za-z][A-Za-z .,'/()-]{2,})"/g);
      for (const hit of hits) {
        if (!LITERALS_ALLOWED.has(hit[2])) offenders.push(`${path} ${hit[1]}="${hit[2]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps Chinese out of the templates too", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      const lines = withoutComments(source).split("\n");
      lines.forEach((line, index) => {
        if (/[\u4e00-\u9fff]/.test(line)) offenders.push(`${path}:${index + 1} ${line.trim().slice(0, 80)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

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
