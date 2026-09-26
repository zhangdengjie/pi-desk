import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PaneResizer from "./PaneResizer.vue";

describe("PaneResizer", () => {
  // The resizer coalesces pointer samples into one width write per frame. Running the frame
  // callback inline - and returning 0, which the component reads as "nothing pending" - keeps
  // the emitted widths synchronous so each case can assert on them directly.
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  it("tracks pointer movement and commits the left pane width", async () => {
    const wrapper = mount(PaneResizer, {
      props: { side: "left", value: 280, min: 220, max: 420, label: "Resize sidebar" },
    });

    await wrapper.trigger("pointerdown", { button: 0, clientX: 280 });
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 344 }));
    window.dispatchEvent(new MouseEvent("pointerup"));

    expect(wrapper.emitted("resize")).toEqual([[344]]);
    expect(wrapper.emitted("commit")).toEqual([[344]]);
  });

  it("reverses pointer movement for the right pane", async () => {
    const wrapper = mount(PaneResizer, {
      props: { side: "right", value: 320, min: 280, max: 720, label: "Resize inspector" },
    });

    await wrapper.trigger("pointerdown", { button: 0, clientX: 1200 });
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 1140 }));
    window.dispatchEvent(new MouseEvent("pointerup"));

    expect(wrapper.emitted("resize")).toEqual([[380]]);
    expect(wrapper.emitted("commit")).toEqual([[380]]);
  });

  it("supports keyboard resizing and clamps the emitted width", async () => {
    const wrapper = mount(PaneResizer, {
      props: { side: "left", value: 280, min: 220, max: 300, label: "Resize sidebar" },
    });

    await wrapper.trigger("keydown", { key: "ArrowRight" });
    await wrapper.setProps({ value: 296 });
    await wrapper.trigger("keydown", { key: "ArrowRight" });

    expect(wrapper.emitted("resize")).toEqual([[292], [300]]);
    expect(wrapper.emitted("commit")).toEqual([[292], [300]]);
    expect(wrapper.attributes("role")).toBe("separator");
  });

  it("reverses arrow direction for the right inspector edge", async () => {
    const wrapper = mount(PaneResizer, {
      props: { side: "right", value: 320, min: 280, max: 720, label: "Resize inspector" },
    });

    await wrapper.trigger("keydown", { key: "ArrowLeft" });

    expect(wrapper.emitted("commit")).toEqual([[332]]);
  });
});
