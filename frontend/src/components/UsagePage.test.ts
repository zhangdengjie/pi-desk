import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "../../bindings/pi-desk/internal/domain";
import UsagePage from "./UsagePage.vue";

const { report, dayKey } = vi.hoisted(() => {
  const today = new Date();
  const dayKey = (offset: number) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  };
  const tokens = (total: number) => ({ input: 10, output: 5, cacheRead: total - 15, cacheWrite: 0, reasoning: 0, total });
  const report = {
    totals: {
      sessions: 3, messages: 10, userMessages: 4, assistantMessages: 4, toolResults: 2,
      tokens: tokens(1634), cost: 0, models: [],
    },
    days: [
      { date: dayKey(1), tokens: tokens(1234), cost: 0, messages: 7, sessions: 2 },
      { date: dayKey(0), tokens: tokens(400), cost: 0, messages: 3, sessions: 1 },
    ],
    workspaces: [],
    sessions: [],
    topModels: [],
    coverage: { filesScanned: 2, filesSkipped: 0, bytesRead: 2048, truncated: false, cachedAt: "" },
  } as UsageReport;
  return { report, dayKey };
});

vi.mock("../services/catalog", () => ({
  catalogService: { getUsageReport: vi.fn(async () => report) },
}));

function cleanupTooltips() {
  for (const node of document.body.querySelectorAll(".usage-chart-tooltip")) node.remove();
}

describe("UsagePage chart tooltip", () => {
  beforeEach(() => {
    cleanupTooltips();
    setActivePinia(createPinia());
  });

  it("shows the day and its usage while a bar is hovered", async () => {
    const wrapper = mount(UsagePage, { global: { plugins: [createPinia()] }, attachTo: document.body });
    await flushPromises();

    const columns = wrapper.findAll(".usage-chart-column");
    // The 7-day window is padded with empty days, so pick the column by its date label instead of
    // its index (the padding depends on the current date).
    const target = columns.find((column) => column.attributes("aria-label")?.startsWith(dayKey(1)));
    expect(target, "the day with 1,234 tokens should have a column").toBeDefined();

    await target!.trigger("mouseenter");

    const tooltip = document.body.querySelector(".usage-chart-tooltip");
    expect(tooltip, "hovering a bar must render the tooltip card").not.toBeNull();
    expect(tooltip!.textContent).toContain(dayKey(1));
    expect(tooltip!.textContent).toContain("1,234");
    // Teleported on purpose: `.usage-chart` scrolls horizontally and would clip an in-flow card.
    expect(wrapper.html()).not.toContain("usage-chart-tooltip");

    await target!.trigger("mouseleave");
    expect(document.body.querySelector(".usage-chart-tooltip")).toBeNull();
    wrapper.unmount();
  });

  it("opens the same card from the keyboard", async () => {
    const wrapper = mount(UsagePage, { global: { plugins: [createPinia()] }, attachTo: document.body });
    await flushPromises();

    const target = wrapper.findAll(".usage-chart-column")
      .find((column) => column.attributes("aria-label")?.startsWith(dayKey(0)));
    expect(target, "today should always have a column").toBeDefined();

    await target!.trigger("focus");
    const tooltip = document.body.querySelector(".usage-chart-tooltip");
    expect(tooltip?.textContent).toContain(dayKey(0));
    expect(tooltip?.textContent).toContain("400");

    await target!.trigger("blur");
    expect(document.body.querySelector(".usage-chart-tooltip")).toBeNull();
    wrapper.unmount();
  });
});