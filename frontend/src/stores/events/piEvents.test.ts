import { describe, expect, it } from "vitest";
import {
  boundedToolOutput,
  contentText,
  contentThinking,
  messageEndParts,
  messageStartParts,
  retryEndFromPayload,
  retryStartFromPayload,
  TOOL_OUTPUT_LIMIT,
  toolProgressFromPayload,
  toolStartFromPayload,
} from "./piEvents";

describe("pi event reducers", () => {
  it("extracts text and thinking parts", () => {
    const content = [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "hello" },
      { type: "text", text: " world" },
    ];
    expect(contentText(content)).toBe("hello world");
    expect(contentThinking(content)).toBe("plan");
    expect(contentText("plain")).toBe("plain");
    expect(contentThinking(content)).toBe("plan");
  });

  it("builds message start/end parts", () => {
    const started = messageStartParts({ content: [{ type: "thinking", thinking: "t" }] });
    expect(started).toEqual({ text: "", thinking: "t", activeExecution: "thinking" });
    const ended = messageEndParts({
      content: [{ type: "text", text: "done" }],
      errorMessage: "boom",
      timestamp: 1700000000000,
    });
    expect(ended.text).toBe("done");
    expect(ended.error).toBe("boom");
    expect(ended.timestampMs).toBe(1700000000000);
  });

  it("bounds oversized tool output", () => {
    const output = "x".repeat(TOOL_OUTPUT_LIMIT + 10);
    const bounded = boundedToolOutput(output);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text.length).toBeLessThan(output.length);
    expect(bounded.text).toContain("output truncated by Pi Desk");
  });

  it("creates a running tool and patches it on completion", () => {
    const started = toolStartFromPayload({ toolCallId: "tool_1", toolName: "edit", args: { path: "x" } }, "tool_1", 1000);
    expect(started.status).toBe("running");
    expect(started.startedAt).toBe(1000);
    const progress = toolProgressFromPayload(started, {
      partialResult: { output: "file.txt" },
    }, false, 1100);
    expect(progress.patch.output).toBe("file.txt");
    expect(progress.patch.status).toBeUndefined();

    const ended = toolProgressFromPayload(started, {
      result: { output: "ok", details: { diff: "+ line" } },
      durationMs: 42,
      isError: false,
    }, true, 1200);
    expect(ended.patch.status).toBe("complete");
    expect(ended.patch.resultReceived).toBe(true);
    expect(ended.patch.durationMs).toBe(42);
    expect(ended.patch.diff?.path).toBe("x");
  });

  it("maps retry payloads", () => {
    const started = retryStartFromPayload({ attempt: 2, maxAttempts: 3, delayMs: 500, errorMessage: "rate limited" }, 1000);
    expect(started.retryAt).toBe(1500);
    const ended = retryEndFromPayload({ success: true, finalError: "old error" }, {
      attempt: 2,
      maxAttempts: 3,
      errorMessage: "rate limited",
    });
    expect(ended.status).toBe("recovered");
    expect(ended.error).toBe("old error");
    expect(ended.attempt).toBe(2);
    expect(ended.maxAttempts).toBe(3);
  });
});
