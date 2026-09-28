import { afterEach, describe, expect, it, vi } from "vitest";
import { vSpin, type SpinValue } from "./spin";

type DirectiveHook = (el: HTMLElement, binding: { value?: SpinValue }) => void;

const mount = (el: HTMLElement, value?: SpinValue) =>
  (vSpin.mounted as unknown as DirectiveHook)(el, { value });
const update = (el: HTMLElement, value?: SpinValue) =>
  (vSpin.updated as unknown as DirectiveHook)(el, { value });
const unmount = (el: HTMLElement) => (vSpin.unmounted as unknown as DirectiveHook)(el, {});

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
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 900, iterations: Infinity, easing: "linear" });
  });

  it("accepts a per-element duration override", () => {
    const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => fakeAnimation());
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;

    mount(document.createElement("span"), { duration: 1400 });

    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 1400 });
  });

  it("cancels the animation on unmount so detached rings do not leak", () => {
    const anim = fakeAnimation();
    HTMLElement.prototype.animate = vi.fn(() => anim) as unknown as typeof HTMLElement.prototype.animate;
    const el = document.createElement("span");

    mount(el);
    unmount(el);

    expect(anim.cancel).toHaveBeenCalledTimes(1);
  });

  it("starts and stops with a reactive condition (dynamic :class sites)", () => {
    // SettingsDialog 的图标常驻，is-spinning 由 :class 控制；v-spin 必须跟着同一个条件。
    const anim = fakeAnimation();
    const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => anim);
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const el = document.createElement("span");

    mount(el, false);
    expect(animate).not.toHaveBeenCalled();

    update(el, true);
    expect(animate).toHaveBeenCalledTimes(1);

    update(el, false);
    expect(anim.cancel).toHaveBeenCalledTimes(1);

    update(el, true);
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it("re-arms after the animation was cancelled out of band", () => {
    const animate = vi.fn(() => fakeAnimation("idle"));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const el = document.createElement("span");

    mount(el);
    update(el, true);

    expect(animate).toHaveBeenCalledTimes(2);
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
    expect(() => mount(document.createElement("span"), { duration: 500 })).not.toThrow();
    expect(() => unmount(document.createElement("span"))).not.toThrow();
  });
});
