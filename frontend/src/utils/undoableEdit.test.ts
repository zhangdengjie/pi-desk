import { describe, expect, it } from "vitest";
import {
  candidateSplit,
  closeUndoGroup,
  minimalPatch,
  shouldCloseUndoGroup,
} from "./undoableEdit";

function apply(
  current: string,
  patch: ReturnType<typeof minimalPatch>,
): string {
  if (!patch) return current;
  return current.slice(0, patch.from) + patch.text + current.slice(patch.to);
}

describe("minimalPatch", () => {
  it("reports nothing for an identical string", () => {
    expect(minimalPatch("hello", "hello")).toBeUndefined();
    expect(minimalPatch("", "")).toBeUndefined();
  });

  it("appends at the end of an unchanged prefix", () => {
    const patch = minimalPatch("hello", "hello @src/app.ts ")!;
    expect(patch).toEqual({ from: 5, to: 5, text: " @src/app.ts " });
    expect(apply("hello", patch)).toBe("hello @src/app.ts ");
  });

  it("replaces only the differing middle", () => {
    const patch = minimalPatch("hello-tail", "HELLO-tail")!;
    expect(patch).toEqual({ from: 0, to: 5, text: "HELLO" });
    expect(apply("hello-tail", patch)).toBe("HELLO-tail");
  });

  it("expresses a deletion as an empty insertion", () => {
    const patch = minimalPatch("abcdef", "abef")!;
    expect(patch).toEqual({ from: 2, to: 4, text: "" });
    expect(apply("abcdef", patch)).toBe("abef");
  });

  it("does not let the suffix trim eat the prefix", () => {
    // "ab" -> "aab": both ends share "ab", so an unbounded suffix walk would claim from=2, to=2 and
    // report an insertion after the string's own last character - which applies as "aba".
    const patch = minimalPatch("ab", "aab")!;
    expect(patch).toEqual({ from: 1, to: 1, text: "a" });
    expect(apply("ab", patch)).toBe("aab");
  });

  it("round-trips a random-ish set of pairs", () => {
    const pairs: [string, string][] = [
      ["", "x"],
      ["x", ""],
      ["a\nb", "a\nbc"],
      ["  lead", "lead"],
      ["the quick brown fox", "the quick red fox"],
      ["你好世界", "你好"],
      ["你好", "你好世界"],
      ["same", "same "],
    ];
    for (const [current, next] of pairs) {
      expect(apply(current, minimalPatch(current, next))).toBe(next);
    }
  });
});

describe("shouldCloseUndoGroup", () => {
  const q = (
    over: Partial<Parameters<typeof shouldCloseUndoGroup>[0]> = {},
  ) => ({
    inputType: "insertText",
    charsSinceGroup: 1,
    composing: false,
    ...over,
  });

  it("closes a group after every ordinary edit, so Cmd+Z is one character", () => {
    expect(shouldCloseUndoGroup(q({ charsSinceGroup: 1 }))).toBe(true);
    // mid-word, at a word end, or a deletion: the engine does not care, it only needs the selection move
    expect(
      shouldCloseUndoGroup(
        q({ charsSinceGroup: 1, inputType: "deleteContentBackward" }),
      ),
    ).toBe(true);
  });

  it("does nothing when no character moved", () => {
    expect(shouldCloseUndoGroup(q({ charsSinceGroup: 0 }))).toBe(false);
  });

  it("never touches the selection during an IME composition", () => {
    expect(shouldCloseUndoGroup(q({ composing: true }))).toBe(false);
    // the flag can lag the event by one frame depending on engine ordering, so the type is checked too
    expect(
      shouldCloseUndoGroup(q({ inputType: "insertCompositionText" })),
    ).toBe(false);
    expect(
      shouldCloseUndoGroup(q({ inputType: "deleteCompositionText" })),
    ).toBe(false);
  });

  it("does not react to its own undo/redo replay", () => {
    expect(shouldCloseUndoGroup(q({ inputType: "historyUndo" }))).toBe(false);
    expect(shouldCloseUndoGroup(q({ inputType: "historyRedo" }))).toBe(false);
  });

  it("counts a pasted block as one ordinary edit", () => {
    expect(
      shouldCloseUndoGroup(
        q({ inputType: "insertFromPaste", charsSinceGroup: 42 }),
      ),
    ).toBe(true);
  });

  describe("candidateSplit", () => {
    it("asks for a split when a candidate landed as a multi-character insertion", () => {
      expect(
        candidateSplit({ before: "前半句", after: "前半句你好世界" }),
      ).toEqual({ from: 3, to: 3, text: "你好世界" });
    });

    it("leaves a single character to the engine - it is already one undo step", () => {
      expect(
        candidateSplit({ before: "前半句", after: "前半句你" }),
      ).toBeUndefined();
      expect(
        candidateSplit({ before: "前半句", after: "前半句" }),
      ).toBeUndefined();
    });

    it("leaves a commit that replaced a selection alone", () => {
      expect(
        candidateSplit({ before: "前半句你好世界", after: "前半句你" }),
      ).toBeUndefined();
      expect(candidateSplit({ before: "世界", after: "你好" })).toBeUndefined();
    });
  });

  it("closeUndoGroup moves the selection and puts it back where it was", () => {
    const calls: Array<[number, number]> = [];
    const target = {
      setSelectionRange: (from: number, to: number) =>
        void calls.push([from, to]),
    };
    closeUndoGroup(target, 5);
    expect(calls).toEqual([
      [4, 5],
      [5, 5],
    ]);
    // at the very start of the field there is nothing to expand backwards into
    calls.length = 0;
    closeUndoGroup(target, 0);
    expect(calls).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });
});
