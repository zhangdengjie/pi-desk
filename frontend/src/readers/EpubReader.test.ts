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

class FakeFoliateView extends HTMLElement {
  book = { toc: [{ label: "Chapter one", href: "ch1.xhtml" }] };
  renderer = { setStyles: vi.fn() };
  async open() {
    // The host must be in the document by the time foliate-js is asked to open a book; otherwise
    // nothing downstream can measure anything.
    opened.push({ connected: this.isConnected, width: this.clientWidth });
  }
  async init() {}
  async goTo() {}
  async prev() {}
  async next() {}
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
});
