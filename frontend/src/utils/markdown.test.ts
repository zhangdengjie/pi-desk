import { describe, expect, it } from "vitest";
import { normalizeMarkdownBreakTags, slugifyHeading, uniqueHeadingSlug } from "./markdown";

describe("heading anchors", () => {
  it("slugs a heading the way GitHub does, and keeps Chinese", () => {
    expect(slugifyHeading("Hello, World!")).toBe("hello-world");
    expect(slugifyHeading("  Ship   It  ")).toBe("ship-it");
    expect(slugifyHeading("v1.2 — now with `code` and **bold**")).toBe("v1.2-now-with-code-and-bold");
    // The stock markdown-it-anchor slugify strips \W, which is every CJK character: a Chinese-only
    // heading would slug to "" and every outline entry would collide on the empty id.
    expect(slugifyHeading("## 目录 与锚点")).toBe("目录-与锚点");
    expect(slugifyHeading("状态：第三次点名")).toBe("状态第三次点名");
    // A heading with nothing word-like left still has to be addressable.
    expect(slugifyHeading("---")).toBe("section");
  });

  it("suffixes repeats the way GitHub numbers them", () => {
    const counts = new Map<string, number>();
    expect(uniqueHeadingSlug(counts, "Setup")).toBe("setup");
    expect(uniqueHeadingSlug(counts, "Setup")).toBe("setup-1");
    expect(uniqueHeadingSlug(counts, "Setup")).toBe("setup-2");
    expect(uniqueHeadingSlug(counts, "其他")).toBe("其他");
  });
});

describe("normalizeMarkdownBreakTags", () => {
  it("turns break tags and escaped breaks into plain newlines", () => {
    expect(normalizeMarkdownBreakTags("A<br>B")).toBe("A\nB");
    expect(normalizeMarkdownBreakTags("A<br/>B")).toBe("A\nB");
    expect(normalizeMarkdownBreakTags("A</br>B")).toBe("A\nB");
    // remark-stringify writes a hard break as `\` + line ending; the backslash used to survive into
    // the prompt sent to Pi.
    expect(normalizeMarkdownBreakTags("A\\\nB")).toBe("A\nB");
    expect(normalizeMarkdownBreakTags("A\\\nB\\\nC")).toBe("A\nB\nC");
  });

  it("keeps a genuinely escaped backslash at the end of a line", () => {
    // Source text `A\` + newline: markdown renders a literal backslash, not a break.
    expect(normalizeMarkdownBreakTags("A\\\\\nB")).toBe("A\\\\\nB");
  });

  it("leaves break syntax inside code alone", () => {
    expect(normalizeMarkdownBreakTags("`A<br>B`")).toBe("`A<br>B`");
    expect(normalizeMarkdownBreakTags("`A\\\nB`")).toBe("`A\\\nB`");
    expect(normalizeMarkdownBreakTags("```sh\nA\\\nB<br>C\n```")).toBe("```sh\nA\\\nB<br>C\n```");
  });

  it("keeps trailing newlines untouched", () => {
    expect(normalizeMarkdownBreakTags("A\\\n")).toBe("A\n");
    expect(normalizeMarkdownBreakTags("plain text")).toBe("plain text");
  });
});
