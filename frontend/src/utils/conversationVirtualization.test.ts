import { describe, expect, it } from "vitest";
import { CONVERSATION_VIRTUALIZATION_THRESHOLD, estimateMessageSize, estimatedChangedFilesSize, shouldVirtualizeMessages } from "./conversationVirtualization";

function message(text = "short") {
  return { role: "assistant" as const, text, thinking: "", images: [] as unknown[], tools: [] };
}

describe("conversation virtualization", () => {
  it("virtualizes every long transcript", () => {
    expect(shouldVirtualizeMessages(Array.from({ length: CONVERSATION_VIRTUALIZATION_THRESHOLD }, () => message()))).toBe(false);
    expect(shouldVirtualizeMessages(Array.from({ length: CONVERSATION_VIRTUALIZATION_THRESHOLD + 1 }, () => message()))).toBe(true);

    const prose = Array.from({ length: CONVERSATION_VIRTUALIZATION_THRESHOLD + 1 }, () => message());
    prose[20] = message("x".repeat(2001));
    expect(shouldVirtualizeMessages(prose)).toBe(true);

    const attachments = Array.from({ length: CONVERSATION_VIRTUALIZATION_THRESHOLD + 1 }, () => message());
    attachments[20].images = [{}];
    expect(shouldVirtualizeMessages(attachments)).toBe(true);
  });

  it("keeps estimated row sizes bounded", () => {
    expect(estimateMessageSize(message())).toBeGreaterThanOrEqual(44);
    expect(estimateMessageSize(message("x".repeat(20_000)))).toBe(900);
  });

  it("grows with character count, not with hard breaks: a table must not move every row below it", () => {
    const table = Array.from({ length: 20 }, (_, index) => `| 第 ${index} 项 | 值 | 说明文字 |`).join("\n").slice(0, 240);
    // Same 240 characters, so the same estimate. Counting line boxes would price the table
    // at 14 lines against the prose's 3, and the virtualizer sums those numbers - the 11
    // rows below would slide 240px the moment the table arrived in one chunk.
    expect(estimateMessageSize(message(table))).toBe(estimateMessageSize(message("x".repeat(240))));
  });

  it("books the changed-files card the settled row will render", () => {
    const row = (diffs: string[], streaming: boolean) => ({
      ...message("result"),
      streaming,
      tools: [],
      executionSteps: [{
        kind: "tools" as const,
        tools: diffs.map((path) => ({ status: "complete", resultReceived: true, diff: { path, text: "" } })),
      }],
    });

    expect(estimatedChangedFilesSize(row([], false))).toBe(0);
    // header (56) + one row (40) + the card's own margin (8)
    expect(estimatedChangedFilesSize(row(["a.ts"], false))).toBe(104);
    // three rows, then the "N more files" row
    expect(estimatedChangedFilesSize(row(["a", "b", "c", "d"], false))).toBe(224);
    // Reserved mid-run too, on purpose: the number must not depend on `streaming`, or the
    // virtualizer's accumulated offsets jump the moment that flag flips.
    expect(estimatedChangedFilesSize(row(["a.ts"], true))).toBe(104);
    expect(estimatedChangedFilesSize(row(["a.ts"], false))).toBe(estimatedChangedFilesSize(row(["a.ts"], true)));
    // A diff whose result has not landed yet is not a card row either.
    expect(estimatedChangedFilesSize({
      ...message("result"),
      streaming: false,
      tools: [{ status: "running", diff: { path: "a.ts", text: "" } }],
    })).toBe(0);
  });

  it("reserves space for assistant request status", () => {
    expect(estimateMessageSize({ ...message("result"), runNotice: { status: "failed" } }))
      .toBe(estimateMessageSize(message("result")) + 48);
  });

  it("uses the collapsed divider height for compaction markers", () => {
    expect(estimateMessageSize({
      ...message(""),
      role: "system",
      compaction: { summary: "x".repeat(20_000), tokensBefore: 241443 },
    })).toBe(48);
  });

  it("does not reserve collapsed reasoning height", () => {
    expect(estimateMessageSize({ ...message(""), thinking: "x".repeat(20_000) })).toBe(22);
    expect(estimateMessageSize({ ...message("result"), thinking: "x".repeat(20_000) })).toBe(44);
  });
});
