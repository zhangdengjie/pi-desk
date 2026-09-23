import { describe, expect, it } from "vitest";
import { normalizeMarkdownBreakTags } from "./markdown";

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
