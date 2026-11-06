// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SPLIT_VIEW_REWRITES,
  applyFoliateSplitView,
  isFoliatePaginator,
} from "./foliateSplitView";

const paginatorPath = new URL("../../node_modules/foliate-js/paginator.js", import.meta.url);
const source = readFileSync(paginatorPath, "utf8");

describe("foliateSplitView", () => {
  it("recognises the paginator", () => {
    expect(isFoliatePaginator(source)).toBe(true);
    expect(isFoliatePaginator("export const x = 1")).toBe(false);
  });

  // This is the guard the vite plugin turns into a build error: if foliate-js changes any of these
  // blocks, the chapter animation silently stops working, so a dependency bump must fail here first.
  it("matches every rewrite in the installed foliate-js", () => {
    const result = applyFoliateSplitView(source);
    expect(result.skipped).toEqual([]);
    expect(result.applied).toHaveLength(SPLIT_VIEW_REWRITES.length);
    expect(result.code).not.toBe(source);
  });

  it("keeps the outgoing view instead of destroying it", () => {
    const { code } = applyFoliateSplitView(source);
    expect(code).toContain("this.#outgoing = this.#view");
    expect(code).toContain("position: 'absolute', inset: '0', zIndex: '1'");
    expect(code).toContain("detail: { incoming: view.element, outgoing: outgoing.element, remove }");
    // Unloading moved out of `#goTo`'s `onLoad` and into `remove()`.
    expect(code).toContain("this.sections[outgoingIndex]?.unload?.()");
    const goToBlock = code.slice(code.indexOf("const onLoad = detail => {"), code.indexOf("this.dispatchEvent(new CustomEvent('load'"));
    expect(goToBlock).not.toContain("unload");
  });

  it("reports the rewrites that no longer match instead of half-applying", () => {
    const drifted = source.replace("this.#view.destroy()", "this.#view.dispose()");
    const result = applyFoliateSplitView(drifted);
    expect(result.skipped).toEqual(["paginator #createView: keep the outgoing view on screen"]);
    expect(result.applied.length).toBe(SPLIT_VIEW_REWRITES.length - 1);
  });

  it("is idempotent enough to leave unrelated code alone", () => {
    const result = applyFoliateSplitView("export const answer = 42;");
    expect(result.code).toBe("export const answer = 42;");
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(SPLIT_VIEW_REWRITES.length);
  });
});