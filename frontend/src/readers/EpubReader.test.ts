import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guard for the reader that never finished loading.
 *
 * `foliate-js` pages a book by measuring the element it was given: `View.open()` appends the
 * paginator into its own shadow root, then `init()` waits for a laid-out iframe. When the host
 * `<div ref="host">` sat inside a `v-else` branch, the element was created while `loading` was still
 * true, `host.value` was null, and the element was never inserted — so it never connected, the
 * paginator never saw a size, and `init()` never resolved. The visible symptom was the loading text
 * staying up forever.
 *
 * The assertions here are about *when* the element is attached, which is exactly what was wrong.
 */

const opened: { connected: boolean; width: number }[] = [];
let lastView: FakeFoliateView | undefined;

class FakeRenderer extends HTMLElement {
  setStyles = vi.fn();
  page = 1;
  pages = 4;
  atEnd = false;
  atStart = false;
  currentIndex = 0;
  doc: Document = document.implementation.createHTMLDocument("chapter");
  getContents = vi.fn(() => [{ index: this.currentIndex, doc: this.doc }]);
  goTo = vi.fn(async ({ index }: { index: number; anchor?: number | ((doc: Document) => number) }) => {
    this.currentIndex = index;
  });
  scrollToAnchor = vi.fn(async () => {});
}

if (typeof customElements.get("fake-foliate-renderer") === "undefined") {
  customElements.define("fake-foliate-renderer", FakeRenderer);
}

class FakeFoliateView extends HTMLElement {
  book = {
    toc: [{ label: "Chapter one", href: "ch1.xhtml" }],
    sections: [
      { id: "s0", linear: "yes" },
      { id: "s1", linear: "yes" },
    ],
  };
  renderer = document.createElement("fake-foliate-renderer") as FakeRenderer;
  prev = vi.fn(async () => {});
  next = vi.fn(async () => {});
  constructor() {
    super();
    lastView = this;
  }
  async open() {
    // The host must be in the document by the time foliate-js is asked to open a book; otherwise
    // nothing downstream can measure anything.
    opened.push({ connected: this.isConnected, width: this.clientWidth });
  }
  async init() {}
  async goTo() {}
  close() {}
}

vi.mock("foliate-js/view.js", () => ({ FoliateView: FakeFoliateView }));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  opened.length = 0;
  globalThis.fetch = vi.fn(async () => new Response(new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]))) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("EpubReader", () => {
  it("keeps the document host mounted while the book is still loading", async () => {
    const { default: EpubReader } = await import("./EpubReader.vue");
    const wrapper = mount(EpubReader, { props: { src: "/workspace-file?path=a.epub", name: "a.epub" } });

    // First frame, before any await resolved: the host must already be in the DOM. A `v-if`-guarded
    // host would be missing here, which is the bug this test exists for.
    expect(wrapper.find(".epub-reader-host").exists()).toBe(true);
    expect(wrapper.text()).toContain("Loading book");
  });

  it("hands a connected element to foliate-js, and stays mounted after loading", async () => {
    const { default: EpubReader } = await import("./EpubReader.vue");
    const wrapper = mount(EpubReader, {
      props: { src: "/workspace-file?path=a.epub", name: "a.epub" },
      attachTo: document.body,
    });
    // Several awaits stand between mount and the toolbar (dynamic import, fetch, open, init), so
    // wait for the outcome rather than counting microtask turns.
    for (let attempt = 0; attempt < 40 && !wrapper.find(".reader-toolbar").exists(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(opened).toHaveLength(1);
    expect(wrapper.find(".reader-toolbar").exists()).toBe(true);
    expect(opened[0].connected).toBe(true);
    expect(wrapper.find(".epub-reader-host").exists()).toBe(true);
    wrapper.unmount();
  });

  it("jumps directly to the adjacent section without animating or scrolling into buffer pages when crossing chapters", async () => {
    const { default: EpubReader } = await import("./EpubReader.vue");
    const wrapper = mount(EpubReader, {
      props: { src: "/workspace-file?path=a.epub", name: "a.epub" },
      attachTo: document.body,
    });
    for (let attempt = 0; attempt < 40 && !wrapper.find(".reader-toolbar").exists(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const view = lastView!;
    const renderer = view.renderer;
    const buttons = wrapper.findAll(".reader-toolbar button");
    const prevBtn = buttons[0];
    const nextBtn = buttons[1];

    // Intra-section turn (`page = 1` of content pages `1..2`, `pages = 4`): animates and calls `view.next()`.
    renderer.currentIndex = 0;
    renderer.page = 1;
    renderer.pages = 4;
    renderer.atEnd = false;
    await nextBtn.trigger("click");
    expect(renderer.hasAttribute("animated")).toBe(true);
    expect(view.next).toHaveBeenCalledTimes(1);
    expect(renderer.goTo).not.toHaveBeenCalled();

    // Last content page of section 0 (`page = 2, pages = 4`, `atEnd` is still false because section 1 exists):
    // must NOT animate and must jump directly to section 1 via `renderer.goTo` instead of `view.next()`.
    renderer.page = 2;
    renderer.pages = 4;
    renderer.atEnd = false;
    await nextBtn.trigger("click");
    expect(renderer.hasAttribute("animated")).toBe(false);
    expect(view.next).toHaveBeenCalledTimes(1);
    expect(renderer.scrollToAnchor).toHaveBeenCalledTimes(1);
    expect(renderer.goTo).toHaveBeenCalledTimes(1);
    const forwardCall = renderer.goTo.mock.calls[0][0];
    expect(forwardCall.index).toBe(1);
    expect(typeof forwardCall.anchor === "function" ? forwardCall.anchor(renderer.doc) : forwardCall.anchor).toBe(0);

    // Wait for the turn lock promise to settle, then turn backward from page 1 of section 1 (`atStart = false`):
    // must jump directly to the end (`anchor = 1`) of section 0 without calling `view.prev()`.
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderer.currentIndex = 1;
    renderer.page = 1;
    renderer.pages = 4;
    renderer.atStart = false;
    await prevBtn.trigger("click");
    expect(renderer.hasAttribute("animated")).toBe(false);
    expect(view.prev).not.toHaveBeenCalled();
    expect(renderer.goTo).toHaveBeenCalledTimes(2);
    const backwardCall = renderer.goTo.mock.calls[1][0];
    expect(backwardCall.index).toBe(0);
    expect(typeof backwardCall.anchor === "function" ? backwardCall.anchor(renderer.doc) : backwardCall.anchor).toBe(1);

    wrapper.unmount();
  });

  it("stops pointerdown propagation inside the book document and prevents empty-area presses on <html>", async () => {
    const { default: EpubReader } = await import("./EpubReader.vue");
    const wrapper = mount(EpubReader, {
      props: { src: "/workspace-file?path=a.epub", name: "a.epub" },
      attachTo: document.body,
    });
    for (let attempt = 0; attempt < 40 && !wrapper.find(".reader-toolbar").exists(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const doc = lastView!.renderer.doc;
    const bubblePointerDown = vi.fn();
    doc.addEventListener("pointerdown", bubblePointerDown);

    // Pressing on empty space (`doc.documentElement`, e.g. empty right column) is both stopped and default-prevented.
    const emptyPress = new Event("pointerdown", { bubbles: true, cancelable: true });
    doc.documentElement.dispatchEvent(emptyPress);
    expect(bubblePointerDown).not.toHaveBeenCalled();
    expect(emptyPress.defaultPrevented).toBe(true);

    // Pressing on content inside `doc.body` stops bubble propagation to foliate's `isPointerSelecting`
    // handler while leaving default selection behavior intact.
    const paragraph = doc.createElement("p");
    doc.body.appendChild(paragraph);
    const textPress = new Event("pointerdown", { bubbles: true, cancelable: true });
    paragraph.dispatchEvent(textPress);
    expect(bubblePointerDown).not.toHaveBeenCalled();
    expect(textPress.defaultPrevented).toBe(false);

    wrapper.unmount();
  });
});
