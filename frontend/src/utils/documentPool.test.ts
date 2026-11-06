import { describe, expect, it } from "vitest";
import { DOCUMENT_POOL, promoteDocumentId, pruneDocumentIds } from "./documentPool";

describe("documentPool", () => {
  it("keeps the most recently visited documents, capped", () => {
    let kept: string[] = [];
    for (const id of ["a", "b", "a", "c"]) kept = promoteDocumentId(kept, id);
    expect(kept).toHaveLength(DOCUMENT_POOL);
    expect(kept[0]).toBe("c");
    expect(kept).not.toContain("b");
  });

  it("forgets ids whose tabs are gone", () => {
    expect(pruneDocumentIds(["a", "b"], ["b"])).toEqual(["b"]);
  });

  it("returns the same array when nothing was pruned", () => {
    const kept = ["a", "b"];
    expect(pruneDocumentIds(kept, ["a", "b", "c"])).toBe(kept);
  });
});
