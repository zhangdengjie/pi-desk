import { afterEach, describe, expect, it, vi } from "vitest";
import { vSpin } from "./spin";

type Hook = (el: HTMLElement) => void;

const mount = (el: HTMLElement) => (vSpin.mounted as unknown as Hook)(el);
const unmount = (el: HTMLElement) => (vSpin.unmounted as unknown as Hook)(el);

function fakeAnimation(playState = "running") {
  return { cancel: vi.fn(), playState, currentTime: 0 } as unknown as Animation & { cancel: ReturnType<typeof vi.fn> };
}

const originalAnimate = HTMLElement.prototype.animate;
const originalMatchMedia = window.matchMedia;

afterEach(() => {
  HTMLElement.prototype.animate = originalAnimate;
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe("v-spin", () => {
  it("rotates through the Web Animations API, not a CSS animation declaration", () => {
    // 侧栏行会因 modifiedAt 变化而换位；CSS animation 在 DOM 重新插入时从 0 重播，WAAPI 不会。
    const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => fakeAnimation());
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;

    mount(document.createElement("span"));

    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 850, iterations: Infinity, easing: "linear" });
  });

  it("cancels the animation on unmount so detached rings do not leak", () => {
    const anim = fakeAnimation();
    HTMLElement.prototype.animate = vi.fn(() => anim) as unknown as typeof HTMLElement.prototype.animate;
    const el = document.createElement("span");

    mount(el);
    unmount(el);

    expect(anim.cancel).toHaveBeenCalledTimes(1);
  });

  it("stays still under prefers-reduced-motion", () => {
    const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => fakeAnimation());
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduced-motion"), media: query })) as unknown as typeof window.matchMedia;

    mount(document.createElement("span"));

    expect(animate).not.toHaveBeenCalled();
  });

  it("degrades to a static ring when the engine has no WAAPI (jsdom)", () => {
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    expect(() => mount(document.createElement("span"))).not.toThrow();
    expect(() => unmount(document.createElement("span"))).not.toThrow();
  });
});
