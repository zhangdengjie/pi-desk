import { beforeEach, describe, expect, it } from "vitest";
import { forgetPanelOpenStates, isPanelPinnedOpen, pinPanelOpen } from "./detailsOpenState";

describe("detailsOpenState", () => {
  beforeEach(() => forgetPanelOpenStates());

  it("reports nothing pinned until a reader touches the panel", () => {
    expect(isPanelPinnedOpen("a-thinking")).toBe(false);
  });

  it("remembers both directions of the reader's choice", () => {
    pinPanelOpen("a-thinking", true);
    pinPanelOpen("b-thinking", false);

    expect(isPanelPinnedOpen("a-thinking")).toBe(true);
    expect(isPanelPinnedOpen("b-thinking")).toBe(false);
  });

  it("keeps the newest panels when the memory hits its cap", () => {
    for (let index = 0; index < 520; index += 1) pinPanelOpen(`step-${index}`, true);

    expect(isPanelPinnedOpen("step-0")).toBe(false);
    expect(isPanelPinnedOpen("step-519")).toBe(true);
  });

  it("refreshes an existing entry instead of evicting it", () => {
    for (let index = 0; index < 500; index += 1) pinPanelOpen(`step-${index}`, false);
    pinPanelOpen("step-499", true);
    pinPanelOpen("fresh", true);

    expect(isPanelPinnedOpen("step-499")).toBe(true);
    expect(isPanelPinnedOpen("step-0")).toBe(false);
    expect(isPanelPinnedOpen("fresh")).toBe(true);
  });
});
