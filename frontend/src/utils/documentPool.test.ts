import { describe, expect, it } from "vitest";
import { DEFAULT_DOCUMENT_POOL, promoteDocumentId, pruneDocumentIds } from "./documentPool";

describe("documentPool", () => {
  it("keeps the most recently visited documents, capped by the configured pool", () => {
    let kept: string[] = [];
    for (const id of ["a", "b", "a", "c"]) kept = promoteDocumentId(kept, id, 2);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe("c");
    expect(kept).not.toContain("b");
  });

  it("defaults to the shipped pool size", () => {
    let kept: string[] = [];
    for (let index = 0; index < DEFAULT_DOCUMENT_POOL + 3; index += 1) kept = promoteDocumentId(kept, `doc-${index}`);
    expect(kept).toHaveLength(DEFAULT_DOCUMENT_POOL);
    expect(kept[0]).toBe(`doc-${DEFAULT_DOCUMENT_POOL + 2}`);
  });

  it("forgets ids whose tabs are gone", () => {
    expect(pruneDocumentIds(["a", "b"], ["b"])).toEqual(["b"]);
  });

  it("returns the same array when nothing was pruned", () => {
    const kept = ["a", "b"];
    expect(pruneDocumentIds(kept, ["a", "b", "c"])).toBe(kept);
  });
});
