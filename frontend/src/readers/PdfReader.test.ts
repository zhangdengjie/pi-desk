import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

/**
 * Regression guard for the PDF reader's scroll plumbing.
 *
 * The scroll listener and the `ResizeObserver` are bound once, on mount. When the scroll container
 * lived behind `v-if="!loading"`, both were attached to `null`: the first window of pages rendered,
 * and then scrolling never asked for another page because nothing was listening. Keeping the
 * container mounted is what makes the two subscriptions meaningful, so that is what is asserted.
 */
vi.mock("./pdfEngine", () => ({
  hasNativePdfSupport: () => true,
  pdfDocumentOptions: () => ({}),
  // Never resolves: the reader must still expose its container in that state.
  loadPdfEngine: () => new Promise(() => {}),
}));

describe("PdfReader", () => {
  it("exposes the scroll container before the engine has loaded anything", async () => {
    const { default: PdfReader } = await import("./PdfReader.vue");
    const wrapper = mount(PdfReader, { props: { src: "/workspace-file?path=a.pdf", name: "a.pdf" } });

    expect(wrapper.find(".pdf-reader-scroll").exists()).toBe(true);
    expect(wrapper.find(".pdf-reader-stack").exists()).toBe(true);
    expect(wrapper.find(".reader-overlay").exists()).toBe(true);
    // The shared ring, not lucide's 288° arc: the open arc's centre of mass orbits the centre.
    expect(wrapper.find(".reader-overlay .loading-ring").exists()).toBe(true);
    wrapper.unmount();
  });
});
