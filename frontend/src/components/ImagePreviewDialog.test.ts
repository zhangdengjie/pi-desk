import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import ImagePreviewDialog from "./ImagePreviewDialog.vue";

const image = { name: "diagram.png", previewUrl: "/session-image?ref=abc.def" };

describe("ImagePreviewDialog zoom", () => {
  let wrapper: ReturnType<typeof mount> | undefined;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    document.body.innerHTML = "";
  });

  async function mountDialog() {
    wrapper = mount(ImagePreviewDialog, { props: { image }, attachTo: document.body });
    const stage = document.querySelector<HTMLElement>(".zoomable-image-stage");
    const picture = document.querySelector<HTMLImageElement>(".zoomable-image-stage img");
    const frame = document.querySelector<HTMLElement>(".zoomable-image-frame");
    if (!stage || !picture || !frame) throw new Error("preview did not render");
    Object.defineProperty(stage, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(stage, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(picture, "naturalWidth", { configurable: true, value: 2000 });
    Object.defineProperty(picture, "naturalHeight", { configurable: true, value: 1000 });
    picture.dispatchEvent(new Event("load"));
    await flush();
    return { stage, picture, frame };
  }

  async function flush() {
    await wrapper?.vm.$nextTick();
    await wrapper?.vm.$nextTick();
  }

  function zoomLevel() {
    return document.querySelector<HTMLElement>(".zoom-level")!;
  }

  function zoomButtons() {
    return [...document.querySelectorAll<HTMLButtonElement>(".image-preview-tools button")];
  }

  it("starts fitted to the stage and reports the effective scale", async () => {
    const { stage, frame, picture } = await mountDialog();

    expect(zoomLevel().textContent?.trim()).toBe("40%");
    expect(frame.style.width).toBe("800px");
    expect(frame.style.height).toBe("400px");
    expect(picture.style.transform).toBe("scale(0.4)");
    expect(stage.classList.contains("is-zoomed")).toBe(false);
    expect(zoomButtons()[0].disabled).toBe(true);
    expect(zoomButtons()[2].disabled).toBe(false);
  });

  it("zooms with the header buttons around the fitted scale", async () => {
    const { stage, picture, frame } = await mountDialog();

    zoomButtons()[2].click();
    await flush();
    expect(zoomLevel().textContent?.trim()).toBe("50%");
    expect(frame.style.width).toBe("1000px");
    expect(frame.style.height).toBe("500px");
    expect(picture.style.transform).toBe("scale(0.5)");
    expect(stage.classList.contains("is-zoomed")).toBe(true);
    expect(zoomButtons()[0].disabled).toBe(false);

    zoomButtons()[0].click();
    await flush();
    expect(zoomLevel().textContent?.trim()).toBe("40%");
    expect(frame.style.width).toBe("800px");
    expect(picture.style.transform).toBe("scale(0.4)");
    expect(stage.classList.contains("is-zoomed")).toBe(false);
    expect(zoomButtons()[0].disabled).toBe(true);
  });

  it("toggles fit and actual size from the percentage and the image", async () => {
    const { picture, frame } = await mountDialog();

    zoomLevel().click();
    await flush();
    expect(zoomLevel().textContent?.trim()).toBe("100%");
    expect(frame.style.width).toBe("2000px");
    expect(picture.style.transform).toBe("scale(1)");
    expect(zoomLevel().title).toBe("Fit to window");

    zoomLevel().click();
    await flush();
    expect(zoomLevel().textContent?.trim()).toBe("40%");
    expect(frame.style.width).toBe("800px");
    expect(picture.style.transform).toBe("scale(0.4)");
    expect(zoomLevel().title).toBe("Actual size");

    const doubleClick = new MouseEvent("dblclick", { bubbles: true, cancelable: true });
    picture.dispatchEvent(doubleClick);
    await flush();
    expect(doubleClick.defaultPrevented).toBe(true);
    expect(zoomLevel().textContent?.trim()).toBe("100%");
  });

  it("pans with a plain wheel and zooms only on pinch", async () => {
    const { stage } = await mountDialog();

    const swipe = new WheelEvent("wheel", { deltaY: -100, clientX: 400, clientY: 300, cancelable: true });
    stage.dispatchEvent(swipe);
    await flush();
    expect(zoomLevel().textContent?.trim()).toBe("40%");

    const pinch = new WheelEvent("wheel", { deltaY: -100, clientX: 400, clientY: 300, cancelable: true });
    Object.defineProperty(pinch, "ctrlKey", { value: true });
    stage.dispatchEvent(pinch);
    await flush();
    expect(pinch.defaultPrevented).toBe(true);
    expect(Number.parseInt(zoomLevel().textContent ?? "", 10)).toBeGreaterThan(40);
  });

  it("closes on Escape", async () => {
    await mountDialog();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(wrapper?.emitted("close")).toHaveLength(1);
  });
});
