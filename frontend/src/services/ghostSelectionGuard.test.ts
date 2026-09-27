import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installGhostSelectionGuard } from "./ghostSelectionGuard";

describe("ghostSelectionGuard", () => {
  let dispose: () => void;

  beforeEach(() => {
    document.body.innerHTML = "<p id=\"text\">selectable transcript text</p>";
    dispose = installGhostSelectionGuard();
  });

  afterEach(() => {
    dispose();
    document.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  function selectAll() {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("text")!);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }

  it("drops a selection that grows while the pointer moves with no button held", () => {
    window.dispatchEvent(new MouseEvent("pointermove", { buttons: 0 }));
    selectAll();
    expect(document.getSelection()?.isCollapsed).toBe(true);
  });

  it("keeps a selection made by a real button-held drag", () => {
    window.dispatchEvent(new MouseEvent("pointerdown", { buttons: 1 }));
    window.dispatchEvent(new MouseEvent("pointermove", { buttons: 1 }));
    selectAll();
    expect(document.getSelection()?.isCollapsed).toBe(false);
    window.dispatchEvent(new MouseEvent("pointerup", { buttons: 0 }));
  });

  it("keeps a keyboard selection made with shift+arrows", () => {
    window.dispatchEvent(new MouseEvent("pointermove", { buttons: 0 }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    selectAll();
    expect(document.getSelection()?.isCollapsed).toBe(false);
  });

  it("keeps an existing selection when the range changes without pointer movement", () => {
    // No pointermove recorded in this session: a programmatic or restored selection
    // must not be mistaken for a ghost.
    selectAll();
    expect(document.getSelection()?.isCollapsed).toBe(false);
  });
});
