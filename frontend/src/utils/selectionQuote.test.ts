import { describe, expect, it } from "vitest";
import {
  SELECTION_QUOTE_MAX,
  appendQuoteToDraft,
  formatSelectionQuote,
  normalizeSelectionText,
} from "./selectionQuote";

describe("normalizeSelectionText", () => {
  it("normalises CRLF and trims", () => {
    expect(normalizeSelectionText("  第一行\r\n第二行  \r\n")).toBe("第一行\n第二行");
  });

  it("collapses runs of blank lines but keeps a paragraph break", () => {
    expect(normalizeSelectionText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("drops trailing spaces before a newline (they would become hard breaks)", () => {
    expect(normalizeSelectionText("a   \nb")).toBe("a\nb");
  });

  it("cuts at the cap and marks the cut", () => {
    const long = "字".repeat(SELECTION_QUOTE_MAX + 20);
    const out = normalizeSelectionText(long);
    expect(Array.from(out)).toHaveLength(SELECTION_QUOTE_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair", () => {
    const out = normalizeSelectionText("🙂".repeat(SELECTION_QUOTE_MAX), 3);
    expect(out).toBe("🙂🙂🙂…");
  });

  it("returns empty for whitespace only", () => {
    expect(normalizeSelectionText("  \n\t\n ")).toBe("");
  });
});

describe("formatSelectionQuote", () => {
  it("prefixes every line and keeps blank lines inside the quote", () => {
    expect(formatSelectionQuote("一\n\n二")).toBe("> 一\n>\n> 二");
  });

  it("returns empty string when there is nothing to quote", () => {
    expect(formatSelectionQuote("   ")).toBe("");
  });
});

describe("appendQuoteToDraft", () => {
  it("starts a fresh draft with the quote and a blank line", () => {
    expect(appendQuoteToDraft("", "> hi")).toBe("> hi\n\n");
  });

  it("separates from an existing paragraph with one blank line", () => {
    expect(appendQuoteToDraft("look:", "> hi")).toBe("look:\n\n> hi\n\n");
  });

  it("does not add a second blank line when the draft already ends with one", () => {
    expect(appendQuoteToDraft("look:\n\n", "> hi")).toBe("look:\n\n> hi\n\n");
  });

  it("keeps the reader on their own line when the draft ends with a single newline", () => {
    expect(appendQuoteToDraft("look:\n", "> hi")).toBe("look:\n\n> hi\n\n");
  });

  it("leaves the draft untouched when there is no quote", () => {
    expect(appendQuoteToDraft("look:  ", "")).toBe("look:  ");
  });
});