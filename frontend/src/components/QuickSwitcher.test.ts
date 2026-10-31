import { DOMWrapper, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { useAppStore, type ThreadSummary } from "../stores/app";
import QuickSwitcher from "./QuickSwitcher.vue";

vi.mock("../services/agent", () => ({ agentService: {}, onPiEvent: () => () => undefined }));
vi.mock("../services/catalog", () => ({ catalogService: {} }));
vi.mock("../services/desktop", () => ({ getBootstrapState: vi.fn() }));
vi.mock("../services/modelconfig", () => ({ modelConfigService: { selectable: vi.fn().mockResolvedValue([]) } }));
vi.mock("../services/repository", () => ({ repositoryService: { clipboardFiles: vi.fn().mockResolvedValue([]) } }));

function thread(overrides: Partial<ThreadSummary>): ThreadSummary {
  return {
    id: "t",
    title: "New task",
    workspace: "pi-desk",
    workspacePath: "/Users/me/pi-desk",
    trust: "approve",
    status: "idle",
    started: false,
    generation: 0,
    ...overrides,
  } as ThreadSummary;
}

function press(init: KeyboardEventInit & { key: string }) {
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

const settle = async () => {
  await nextTick();
  await nextTick();
};

describe("QuickSwitcher", () => {
  let wrapper: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    document.body.innerHTML = "";
  });

  it("opens on ⌘K and lists the most recent sessions", async () => {
    const store = useAppStore();
    store.threads = [
      thread({ id: "a", title: "修滚动抖动", modifiedAt: "2026-10-31T08:00:00Z" }),
      thread({ id: "b", title: "升级 1.4.0", modifiedAt: "2026-10-30T08:00:00Z", archived: true }),
    ];
    wrapper = mount(QuickSwitcher, { attachTo: document.body });

    press({ key: "k", metaKey: true });
    await settle();

    expect(document.querySelector(".quick-switcher")).not.toBeNull();
    expect(document.querySelectorAll(".quick-switcher-row")).toHaveLength(1);
    expect(document.querySelector(".quick-switcher-title")?.textContent).toContain("修滚动抖动");
  });

  it("filters by title and opens the selection with Enter", async () => {
    const store = useAppStore();
    store.threads = [
      thread({ id: "a", title: "修滚动抖动" }),
      thread({ id: "b", title: "升级 1.4.0" }),
    ];
    const select = vi.spyOn(store, "selectThread").mockImplementation(() => {});
    wrapper = mount(QuickSwitcher, { attachTo: document.body });

    press({ key: "k", metaKey: true });
    await settle();
    // Teleported to <body>, so it is outside the wrapper's own tree; DOMWrapper binds to the node.
    const input = new DOMWrapper(document.querySelector(".quick-switcher-search input"));
    await input.setValue("1.4");
    await settle();
    expect(document.querySelectorAll(".quick-switcher-row")).toHaveLength(1);

    await input.trigger("keydown", { key: "Enter" });
    await settle();

    expect(select).toHaveBeenCalledWith("b");
    expect(document.querySelector(".quick-switcher")).toBeNull();
  });

  it("closes on Escape and on a second ⌘K", async () => {
    useAppStore().threads = [thread({ id: "a", title: "one" })];
    wrapper = mount(QuickSwitcher, { attachTo: document.body });

    press({ key: "k", metaKey: true });
    await settle();
    expect(document.querySelector(".quick-switcher")).not.toBeNull();

    press({ key: "Escape" });
    await settle();
    expect(document.querySelector(".quick-switcher")).toBeNull();

    press({ key: "k", metaKey: true });
    await settle();
    press({ key: "k", metaKey: true });
    await settle();
    expect(document.querySelector(".quick-switcher")).toBeNull();
  });

  it("moves exactly one row per arrow press, even from the focused search box", async () => {
    useAppStore().threads = [
      thread({ id: "a", title: "one", modifiedAt: "2026-10-31T08:00:00Z" }),
      thread({ id: "b", title: "two", modifiedAt: "2026-10-30T08:00:00Z" }),
      thread({ id: "c", title: "three", modifiedAt: "2026-10-29T08:00:00Z" }),
    ];
    wrapper = mount(QuickSwitcher, { attachTo: document.body });
    press({ key: "k", metaKey: true });
    await settle();

    // Real path: the caret is in the input, so the event starts there and bubbles to document.
    const input = new DOMWrapper(document.querySelector(".quick-switcher-search input"));
    const active = () => document.querySelectorAll(".quick-switcher-row")[0] && Array.from(document.querySelectorAll(".quick-switcher-row")).findIndex((row) => row.getAttribute("aria-selected") === "true");
    expect(active()).toBe(0);
    await input.trigger("keydown", { key: "ArrowDown" });
    await settle();
    expect(active()).toBe(1);
    await input.trigger("keydown", { key: "ArrowDown" });
    await settle();
    expect(active()).toBe(2);
    await input.trigger("keydown", { key: "ArrowUp" });
    await settle();
    expect(active()).toBe(1);
  });

  it("does not stack on top of another dialog", async () => {
    useAppStore().threads = [thread({ id: "a", title: "one" })];
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    document.body.appendChild(other);
    wrapper = mount(QuickSwitcher, { attachTo: document.body });

    press({ key: "k", metaKey: true });
    await settle();
    expect(document.querySelector(".quick-switcher")).toBeNull();
  });
});