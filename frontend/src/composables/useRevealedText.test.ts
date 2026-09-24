import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRevealedText } from "./useRevealedText";
import { applyStreamTuning, resetStreamTuning, SHIPPED, streamTuning } from "../utils/streamTuning";

// A separate file on purpose: the tuning is a module singleton, and a case that changes it
// must not decide how the next case in another file is paced. Vitest gives each file its
// own module registry, so this cannot leak.
function harness(initial = "", live = true) {
  const source = ref(initial);
  const animate = ref(live);
  const wrapper = mount(defineComponent({
    setup() {
      const shown = useRevealedText(() => source.value, () => animate.value);
      return { shown, source, animate };
    },
    template: "<span>{{ shown }}</span>",
  }));
  return { wrapper, source, animate };
}

describe("useRevealedText + streamTuning", () => {
  // The tuning is a module singleton; without this the case above decides how the next
  // one is paced.
  afterEach(() => {
    resetStreamTuning();
    vi.useRealTimers();
  });

  it("paces one character per frame when the config file says so", async () => {
    vi.useFakeTimers();
    applyStreamTuning({ split: 1000, floor: 1, ceiling: 1 }, null);
    const { wrapper, source } = harness("");
    try {
      source.value = "abcdefghij";
      await flushPromises();

      await vi.advanceTimersByTimeAsync(16);
      expect(wrapper.text()).toBe("a");
      await vi.advanceTimersByTimeAsync(16);
      expect(wrapper.text()).toBe("ab");
      await vi.advanceTimersByTimeAsync(1600);
      expect(wrapper.text()).toBe("abcdefghij");
    } finally {
      wrapper.unmount();
    }
    vi.useRealTimers();
  });

  it("lands a whole chunk in one frame when the ceiling is generous", async () => {
    vi.useFakeTimers();
    applyStreamTuning({ split: 1, floor: 1, ceiling: 100000 }, null);
    const { wrapper, source } = harness("");
    try {
      source.value = "x".repeat(500);
      await flushPromises();
      // One fifth of the backlog per frame is geometric, so a 500 character chunk needs
      // about half a second - but that is still whole-sentence-free compared with a raw
      // render, and it is what a large ceiling buys.
      await vi.advanceTimersByTimeAsync(1000);
      expect(wrapper.text()).toBe("x".repeat(500));
    } finally {
      wrapper.unmount();
    }
    vi.useRealTimers();
  });

  it("keeps the shipped numbers when nothing was applied", () => {
    expect(streamTuning.reveal).toEqual(SHIPPED.reveal);
    expect(streamTuning.scroll).toEqual(SHIPPED.scroll);
  });
});
