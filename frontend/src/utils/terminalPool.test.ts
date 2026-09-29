import { describe, expect, it } from "vitest";
import { TERMINAL_POOL, promoteTerminalId, pruneTerminalIds } from "./terminalPool";

describe("terminalPool", () => {
  it("keeps the terminals the reader moves between warm, most recent first", () => {
    let kept: string[] = [];
    kept = promoteTerminalId(kept, "a");
    kept = promoteTerminalId(kept, "b");
    expect(kept).toEqual(["b", "a"]);

    // Revisiting an open terminal must not duplicate it, or the pool would hold one slot twice.
    kept = promoteTerminalId(kept, "a");
    expect(kept).toEqual(["a", "b"]);
  });

  it("caps the pool, because every hidden pane still parses its pty output", () => {
    const kept = promoteTerminalId(promoteTerminalId(promoteTerminalId([], "a"), "b"), "c");
    expect(kept).toEqual(["c", "b"]);
    expect(kept.length).toBe(TERMINAL_POOL);
  });

  it("forgets tabs that closed and a task that was switched away from", () => {
    const kept = promoteTerminalId(promoteTerminalId([], "a"), "b");
    expect(pruneTerminalIds(kept, ["b", "c"])).toEqual(["b"]);
    // the same array comes back when nothing dropped, so the caller's ref does not churn
    const same = pruneTerminalIds(kept, ["a", "b"]);
    expect(same).toBe(kept);
    expect(pruneTerminalIds(kept, [])).toEqual([]);
  });
});
