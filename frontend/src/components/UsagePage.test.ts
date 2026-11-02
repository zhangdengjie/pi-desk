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
    workspaces: [
      { path: "/w/pi-desk", name: "pi-desk", tokens: tokens(149_800_000), cost: 0, messages: 3278, sessions: 15 },
      { path: "/w/go-stock", name: "go-stock", tokens: tokens(40_700_000), cost: 0, messages: 1136, sessions: 6 },
    ],
    sessions: [
      {
        path: "/p/a.jsonl", title: "nightly run", cwd: "/w/pi-desk", model: "deepseek-v4.1-flash",
        tokens: tokens(52_900_000), cost: 0, messages: 878, updatedAt: "2026-10-31T20:58:00Z",
      },
    ],
    topModels: [
      { provider: "bailian", model: "deepseek-v4.1-flash", assistantMessages: 900, tokens: tokens(189_700_000), cost: 0 },
    ],
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
describe("UsagePage tables", () => {
  function mountPage() {
    return mount(UsagePage, { global: { plugins: [createPinia()] }, attachTo: document.body });
  }

  it("marks every numeric header so labels sit above their numbers", async () => {
    const wrapper = mountPage();
    await flushPromises();

    const tables = wrapper.findAll(".usage-table");
    expect(tables.length, "workspaces + sessions + models").toBe(3);

    for (const table of tables) {
      const name = table.classes().join(" ");
      const headers = table.findAll("th");
      const firstRow = table.findAll("tbody tr")[0];
      expect(firstRow, `${name} should render at least one row`).toBeDefined();
      const cells = firstRow.findAll("td");
      expect(cells.length, `${name} header/cell count must match`).toBe(headers.length);

      headers.forEach((header, index) => {
        const cell = cells[index];
        const numeric = cell.classes().some((cls) => cls === "usage-cell-number" || cls === "usage-cell-time");
        // Header is right-aligned through `.is-numeric`; a numeric cell under a left-aligned header is
        // exactly the misalignment this test pins down.
        expect(header.classes().includes("is-numeric"), `${name} column ${index + 1}`).toBe(numeric);
      });
    }

    wrapper.unmount();
  });

  it("switches the token unit and leaves the count columns alone", async () => {
    const wrapper = mountPage();
    await flushPromises();

    const cells = () => wrapper.findAll(".usage-table.is-workspaces tbody tr")[0].findAll("td");
    expect(cells()[1].text()).toBe("149.8M");
    expect(cells()[2].text(), "messages keep the plain count").toBe("3,278");

    // Index order is the contract: auto / K / M / B (labels are translated).
    const units = wrapper.findAll(".usage-units button");
    expect(units.length, "auto + K + M + B").toBe(4);

    await units[1].trigger("click");
    expect(cells()[1].text()).toBe("149,800K");
    expect(cells()[2].text(), "unit switch must not touch message counts").toBe("3,278");

    await units[3].trigger("click");
    expect(cells()[1].text()).toBe("0.15B");

    await units[0].trigger("click");
    expect(cells()[1].text(), "auto restores the per-row magnitude").toBe("149.8M");

    wrapper.unmount();
  });
});
