import { describe, expect, it } from "vitest";

import { decodePercentRuns } from "./percentText";

/** The shape that started this: an MCP `chat/stream` call whose whole answer arrives percent-encoded. */
const STREAM = `{"tool":"getSignalQuality","run":"run-12"}%E8%AF%B7%E6%94%BE%E5%BF%83%EF%BC%9A**%22%E6%B2%A1%E6%9C%89%E8%AE%B0%E5%BD%95%22**%0A%E7%9D%A1%E7%9C%A0`;

describe("decodePercentRuns", () => {
  it("turns an encoded tool stream into readable text with real line breaks", () => {
    const { text, decoded } = decodePercentRuns(STREAM);
    expect(decoded).toBe(true);
    expect(text).toContain("请放心");
    expect(text).toContain('"没有记录"');
    expect(text).toContain("睡眠");
    // %0A was a literal six characters on screen; now it breaks the line.
    expect(text.split("\n")).toHaveLength(2);
    // the JSON punctuation that was never encoded stays where it was
    expect(text.startsWith('{"tool":"getSignalQuality","run":"run-12"}')).toBe(true);
  });

  it("leaves ASCII-only escapes quoted when the text merely quotes a URL", () => {
    for (const input of [
      "printf(\"%d %s\\n\")",
      "pass rate 50%25 of 2",
      "GET /q?path=%2Fa%2Fb&sep=%20%20",
    ]) {
      expect(decodePercentRuns(input).text).toBe(input);
    }
  });

  it("decodes the CJK half of a query string and keeps its structure quoted", () => {
    const input = "GET https://api.example.com/q?name=%E4%BD%A0&path=%2Fa%2Fb&sep=%20%20";
    expect(decodePercentRuns(input).text).toBe("GET https://api.example.com/q?name=你&path=%2Fa%2Fb&sep=%20%20");
  });

  it("decodes ASCII escapes too when the whole payload is one encoded blob", () => {
    // encodeURIComponent of a JSON body: density, not per-run luck, is what says "this is encoded"
    const body = JSON.stringify({ message: "你好", n: [1, 2] });
    const input = encodeURIComponent(body);
    expect(decodePercentRuns(input).text).toBe(body);
  });

  it("decodes the non-ASCII runs of a mixed line but keeps its escapes intact", () => {
    const { text } = decodePercentRuns("url=https://x/y?a=1%26b=2 note=%E4%BD%A0%E5%A5%BD");
    expect(text).toBe("url=https://x/y?a=1%26b=2 note=你好");
  });

  it("refuses runs that are not text (control bytes, lone continuation bytes, overlong forms)", () => {
    for (const input of ["%00%01%02%03", "%C0%80%C0%AF", "%F5%80%80%80", "%80%80%80"]) {
      expect(decodePercentRuns(input).text).toBe(input);
    }
  });

  it("survives a run cut mid-sequence by the output cap", () => {
    // head truncated: the orphaned %99 becomes one replacement char, the rest turns readable
    const { text, decoded } = decodePercentRuns("F%99%E6%A0%87%E9%A2%98");
    expect(decoded).toBe(true);
    expect(text).toContain("标题");
    expect(text).toMatch(/^F\uFFFD?标题$/);
    // tail truncated: readable part kept, dangling bytes still shown as written
    expect(decodePercentRuns("%E4%BD%A0%E5%A5").text).toBe("你%E5%A5");
  });

  it("is a no-op (same string reference) for text with no percent or no candidate run", () => {
    for (const input of ["", "all passed\n", "404 not found", "100% done"]) {
      const result = decodePercentRuns(input);
      expect(result.text).toBe(input);
      expect(result.decoded).toBe(false);
    }
  });

  it("round-trips arbitrary text through a stream-like encoding", () => {
    const original = "推理完成 ✅ 1e9 < 2^31 — 100% 可靠\n第二行";
    const encoded = encodeURIComponent(original);
    expect(decodePercentRuns(encoded).text).toBe(original);
  });

  it("does not touch a single escape pair even when it would decode", () => {
    const input = "%E4%BD"; // incomplete: two pairs, but not valid UTF-8
    expect(decodePercentRuns(input).text).toBe(input);
  });
});
