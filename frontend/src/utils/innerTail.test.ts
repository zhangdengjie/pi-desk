import { afterEach, describe, expect, it, vi } from "vitest";
import { attachInnerTail } from "./innerTail";

function box(options: { scrollTop?: number; clientHeight?: number; scrollHeight?: number } = {}) {
  const element = document.createElement("div");
  const sizes = {
    scrollTop: options.scrollTop ?? 0,
    clientHeight: options.clientHeight ?? 132,
    scrollHeight: options.scrollHeight ?? 880,
  };
  Object.defineProperties(element, {
    scrollTop: { configurable: true, get: () => sizes.scrollTop, set: (value: number) => { sizes.scrollTop = value; } },
    clientHeight: { configurable: true, get: () => sizes.clientHeight },
    scrollHeight: { configurable: true, get: () => sizes.scrollHeight },
  });
  return { element, sizes };
}

describe("attachInnerTail", () => {
  afterEach(() => vi.useRealTimers());

  it("pins the newest line while content grows", () => {
    const { element, sizes } = box({ scrollHeight: 880 });
    const tail = attachInnerTail(element);

    sizes.scrollHeight = 940;
    tail.step();
    expect(sizes.scrollTop).toBe(940);
    tail.destroy();
  });

  it("stands down when the reader scrolls up and re-arms at the bottom", () => {
    const { element, sizes } = box({ scrollTop: 748 });
    const tail = attachInnerTail(element);
    tail.step();
    expect(sizes.scrollTop).toBe(880);

    sizes.scrollTop = 10;
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -30 }));
    sizes.scrollHeight = 1200;
    tail.step();
    expect(sizes.scrollTop).toBe(10);

    sizes.scrollTop = 1180;
    element.dispatchEvent(new Event("scroll"));
    sizes.scrollHeight = 1300;
    tail.step();
    expect(sizes.scrollTop).toBe(1300);
    tail.destroy();
  });

  it("releases on the keyboard too, and stops listening once destroyed", () => {
    const { element, sizes } = box();
    const tail = attachInnerTail(element);
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
    sizes.scrollHeight = 1500;
    tail.step();
    expect(sizes.scrollTop).toBe(0);

    tail.destroy();
    sizes.scrollTop = 0;
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -30 }));
    const rebuilt = attachInnerTail(element);
    expect(rebuilt.isArmed()).toBe(true);
    rebuilt.destroy();
    tail.stop();
    expect(tail.isArmed()).toBe(false);
  });
});
