import { describe, expect, it } from "vitest";
import { fuzzyScore, rankFuzzy } from "./fuzzySearch";

describe("fuzzy search", () => {
  it("matches ordered characters and prefers file-name and boundary matches", () => {
    expect(fuzzyScore("components/ComposerBar.vue", "cmpbar")).toBeGreaterThanOrEqual(0);
    expect(fuzzyScore("components/ComposerBar.vue", "zbar")).toBe(-1);
    const files = [
      { name: "bar.ts", path: "deep/bar.ts" },
      { name: "other.ts", path: "components/ComposerBar.vue" },
    ];
    expect(rankFuzzy(files, "bar", (file) => [file.name, file.path])[0].name).toBe("bar.ts");
  });

  it("rejects an item that matches none of its targets", () => {
    // The primary target carries a +24 preference bonus. Added to a miss (-1) that becomes 23, which
    // used to keep *every* item in the result: a `@zzz` mention listed eight arbitrary files.
    const files = [
      { name: "bar.ts", path: "deep/bar.ts" },
      { name: "other.ts", path: "components/ComposerBar.vue" },
    ];
    expect(rankFuzzy(files, "zzz", (file) => [file.name, file.path])).toEqual([]);
    // A hit on a later target is still a hit - it just does not get the bonus.
    expect(rankFuzzy(files, "deep", (file) => [file.name, file.path]).map((file) => file.name)).toEqual(["bar.ts"]);
  });
});
