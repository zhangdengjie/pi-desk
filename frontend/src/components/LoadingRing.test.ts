import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoadingRing from "./LoadingRing.vue";

const originalAnimate = HTMLElement.prototype.animate;

afterEach(() => {
  HTMLElement.prototype.animate = originalAnimate;
});

describe("LoadingRing", () => {
  it("is a full-circle ring sized through the CSS custom property, not through Tailwind utilities", () => {
    // 几何量必须留在 layout.css 的 `.loading-ring` 里：tailwind 以 important 引入，
    // 调用方挂 size-* 会压过 CSS（AGENTS.md §4）。
    const wrapper = mount(LoadingRing, { props: { size: 22 } });
    const ring = wrapper.get("span.loading-ring");

    expect(ring.classes()).toEqual(["loading-ring"]);
    expect(ring.attributes("style")).toContain("--loading-ring-size: 22px");
    expect(ring.attributes("aria-hidden")).toBe("true");
  });

  it("rotates through v-spin so a list reorder cannot restart it", () => {
    const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({ cancel: vi.fn(), playState: "running" }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;

    mount(LoadingRing);

    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 900, iterations: Infinity, easing: "linear" });
  });

  it("takes a per-instance duration", () => {
    const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({ cancel: vi.fn(), playState: "running" }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;

    mount(LoadingRing, { props: { duration: 1400 } });

    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 1400 });
  });
});
