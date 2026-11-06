// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTINUOUS_REWRITES, applyContinuousPagination } from "./foliateContinuous";

const source = readFileSync(
  new URL("../../node_modules/foliate-js/paginator.js", import.meta.url),
  "utf8",
);

describe("foliateContinuous", () => {
  // The vite plugin turns a skipped rewrite into a build error: a foliate-js bump that moves either
  // block must fail the build rather than silently putting the reader back on one section per view.
  it("matches every rewrite in the installed foliate-js", () => {
    const result = applyContinuousPagination(source);
    expect(result.skipped).toEqual([]);
    expect(result.applied).toHaveLength(CONTINUOUS_REWRITES.length);
  });

  it("consults the hooks and keeps the old behaviour without them", () => {
    const { code } = applyContinuousPagination(source);
    expect(code).toContain("typeof this.resolveIndex === 'function'");
    expect(code).toContain("this.resolveIndex(range) ?? this.#index");
    expect(code).toContain("typeof this.unitIndexFor === 'function'");
    expect(code).toContain("index = this.unitIndexFor(index)");
  });

  it("reports which rewrite drifted", () => {
    const drifted = source.replace("const detail = { reason, range, index }", "const detail = { reason, range }");
    const result = applyContinuousPagination(drifted);
    expect(result.skipped).toEqual([
      "paginator #afterScroll: report the section the range belongs to",
    ]);
  });
});