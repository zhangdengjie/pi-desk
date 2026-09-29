import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { tr } from "../i18n";
import BrowserPane from "./BrowserPane.vue";

const browser = vi.hoisted(() => ({
  startTab: vi.fn().mockResolvedValue({ attached: true, url: "https://example.test" }),
  command: vi.fn().mockResolvedValue(undefined),
  openUrl: vi.fn().mockResolvedValue(undefined),
  bounds: vi.fn().mockResolvedValue(undefined),
}));
const storeState = vi.hoisted(() => ({ activeThreadId: "thread", paneResizing: false }));
vi.mock("../stores/app", () => ({ useAppStore: () => storeState }));
vi.mock("../services/browser", () => ({ browserService: browser, onBrowserEvent: () => () => undefined }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("hides the native viewport for the application menu and restores it on dismissal", async () => {
  let scheduled: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { scheduled.push(callback); return scheduled.length; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 80, 600, 400));
  const wrapper = mount(BrowserPane, { attachTo: document.body, props: { tab: { id: "page", kind: "browser", title: "Browser" } } });
  const menu = document.createElement("div");
  menu.className = "command-menu workspace-application-menu";
  menu.setAttribute("role", "menu");
  const update = async () => {
    await flushPromises();
    const callbacks = scheduled; scheduled = [];
    callbacks.forEach(callback => callback(0));
    await flushPromises();
  };
  try {
    await update();
    expect(browser.bounds.mock.lastCall?.[2]).toBe(true);
    document.body.append(menu);
    await update();
    expect(browser.bounds.mock.lastCall?.[2]).toBe(false);
    menu.remove();
    await update();
    expect(browser.bounds.mock.lastCall?.[2]).toBe(true);
  } finally { menu.remove(); wrapper.unmount(); }
});

it("opens DevTools for this exact tab without a handback control", async () => {
  const wrapper = mount(BrowserPane, { props: { tab: { id: "page", kind: "browser", title: "Browser" } } });
  try {
    await flushPromises();
    expect(wrapper.text()).not.toMatch(/接管|交还|Take over|Hand back/);
    await wrapper.get(`[aria-label="${tr("browser.devtools")}"]`).trigger("click");
    expect(browser.command).toHaveBeenCalledWith("page", "devtools");
    await wrapper.get("input").setValue("example.test/path");
    await wrapper.get("form").trigger("submit");
    expect(browser.openUrl).toHaveBeenCalledWith("https://example.test/path", "page");
  } finally { wrapper.unmount(); }
});

it("skips the whole-document overlay query while a divider drag is in flight, and re-reads on release", async () => {
  let scheduled: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { scheduled.push(callback); return scheduled.length; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 80, 600, 400));
  const query = vi.spyOn(document, "querySelector");
  const update = async () => {
    await flushPromises();
    const callbacks = scheduled; scheduled = [];
    callbacks.forEach(callback => callback(0));
    await flushPromises();
  };
  const wrapper = mount(BrowserPane, { attachTo: document.body, props: { tab: { id: "page", kind: "browser", title: "Browser" } } });
  const menu = document.createElement("div");
  menu.className = "command-menu";
  menu.setAttribute("role", "menu");
  try {
    await update();
    expect(browser.bounds.mock.lastCall?.[2]).toBe(true);

    // A drag rewrites the shell every frame; the overlay question cannot change while the button is
    // down, so the frame must not pay for a full-document querySelector.
    storeState.paneResizing = true;
    query.mockClear();
    document.body.append(menu);
    await update();
    expect(query.mock.calls.filter(([selector]) => String(selector).includes("aria-modal"))).toHaveLength(0);
    expect(browser.bounds.mock.lastCall?.[2]).toBe(true);

    // Release re-asks, so a native view can never stay visible under an open overlay. The re-ask is
    // driven by the DOM patch the release's commit causes, exactly as in a real drag.
    storeState.paneResizing = false;
    document.body.classList.add("after-divider-drag");
    await update();
    expect(query.mock.calls.filter(([selector]) => String(selector).includes("aria-modal")).length).toBeGreaterThan(0);
    expect(browser.bounds.mock.lastCall?.[2]).toBe(false);
  } finally { menu.remove(); storeState.paneResizing = false; wrapper.unmount(); }
});

it("shows the blank-page prompt without letting the native surface cover it", async () => {
  const scheduled: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { scheduled.push(callback); return scheduled.length; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 80, 600, 400));
  browser.startTab.mockResolvedValueOnce({ attached: true, url: "about:blank" });
  const wrapper = mount(BrowserPane, { props: { tab: { id: "blank", kind: "browser", title: "Browser", url: "about:blank" } } });
  try {
    await flushPromises();
    expect(wrapper.get("input").element.value).toBe("");
    expect(wrapper.get(".browser-empty").text()).toContain(tr("browser.emptyHint"));
    scheduled.splice(0).forEach(callback => callback(0));
    await flushPromises();
    expect(browser.bounds).toHaveBeenCalledWith("blank", expect.any(Object), false);
  } finally { wrapper.unmount(); }
});
