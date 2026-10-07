import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tr } from "../i18n";
import { type PanelTab, useAppStore } from "../stores/app";
import InspectorPanel from "./InspectorPanel.vue";
import { buildToolDiff } from "../utils/toolDiff";

vi.mock("../services/agent", () => ({ agentService: {}, onPiEvent: () => () => undefined }));
vi.mock("../services/catalog", () => ({ catalogService: {} }));
vi.mock("../services/desktop", () => ({ getBootstrapState: vi.fn() }));
const repositoryMocks = vi.hoisted(() => ({
  diff: vi.fn(),
  previewFile: vi.fn(),
  openFile: vi.fn(),
  revealFile: vi.fn(),
}));
vi.mock("../services/repository", () => ({ repositoryService: repositoryMocks }));
vi.mock("../services/terminal", () => ({ terminalService: {}, onTerminalEvent: () => () => undefined }));
function panelState(threadId: string, tab: Partial<PanelTab> & Pick<PanelTab, "kind" | "path">) {
  const id = threadId + ":" + tab.path;
  return { inspectorByThread: { [threadId]: { tabs: [{ id, title: tab.path || "", ...tab }], activeId: id, open: true, width: 600, expanded: false } } };
}
describe("InspectorPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reorders a pointer-dragged tab without activating the drop target", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.activeThreadId = "drag";
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    store.openPanelTab({ id: "one", kind: "files", title: "One" });
    store.openPanelTab({ id: "two", kind: "files", title: "Two" });
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    const tab = wrapper.findAll('[role="tab"]')[1];
    tab.element.setPointerCapture = vi.fn();
    const point = vi.spyOn(document, "elementFromPoint").mockReturnValue(wrapper.findAll(".panel-tab")[0].element);
    await tab.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 200, clientY: 20 });
    await tab.trigger("pointerup", { pointerId: 1, clientX: 20, clientY: 20 });
    await tab.trigger("click");
    expect(store.activePanel?.tabs.map((tab) => tab.id)).toEqual(["two", "one"]);
    expect(store.activePanel?.activeId).toBe("two");
    point.mockRestore();
    wrapper.unmount();
  });

  it("lifts the dragged tab into a ghost that tracks the cursor, and only reflows on release", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.activeThreadId = "ghost";
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    store.openPanelTab({ id: "one", kind: "files", title: "One" });
    store.openPanelTab({ id: "two", kind: "files", title: "Two" });
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    // jsdom reports every box as 0x0 at the origin, which would make the ghost's offset meaningless.
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 150, y: 10, left: 150, top: 10, width: 120, height: 32, right: 270, bottom: 42, toJSON: () => ({}),
    } as DOMRect);
    const tabs = wrapper.findAll(".panel-tab");
    const tab = wrapper.findAll('[role="tab"]')[1];
    tab.element.setPointerCapture = vi.fn();
    const point = vi.spyOn(document, "elementFromPoint").mockReturnValue(tabs[0].element);
    const ghost = () => document.body.querySelector(".panel-tab-ghost");

    await tab.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 200, clientY: 20 });
    expect(ghost()).toBeNull(); // a press is not a drag yet - no flicker on a plain click

    await tab.trigger("pointermove", { pointerId: 1, clientX: 203, clientY: 20 });
    expect(ghost()).toBeNull(); // still inside the 5px slop

    await tab.trigger("pointermove", { pointerId: 1, clientX: 300, clientY: 60 });
    // Grabbed 50px into a 120px slot, so the ghost trails the cursor by exactly that.
    expect(ghost()?.getAttribute("style")).toContain("left: 250px");
    expect(ghost()?.getAttribute("style")).toContain("top: 50px");
    expect(ghost()?.getAttribute("style")).toContain("width: 120px");
    expect(ghost()?.textContent).toContain("Two");
    expect(tabs[1].classes()).toContain("is-dragging");
    expect(tabs[0].classes()).toContain("is-drop-target");
    // Nothing has moved yet: the row only reflows when the reader lets go.
    expect(store.activePanel?.tabs.map((tab) => tab.id)).toEqual(["one", "two"]);

    await tab.trigger("pointerup", { pointerId: 1, clientX: 300, clientY: 60 });
    expect(ghost()).toBeNull();
    expect(store.activePanel?.tabs.map((tab) => tab.id)).toEqual(["two", "one"]);

    point.mockRestore();
    rect.mockRestore();
    wrapper.unmount();
  });

  it("scrolls the tab strip under the cursor while a tab is dragged to its edge", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.activeThreadId = "edge";
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    store.openPanelTab({ id: "one", kind: "files", title: "One" });
    store.openPanelTab({ id: "two", kind: "files", title: "Two" });
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    const strip = wrapper.get(".panel-tabs").element;
    Object.defineProperty(strip, "clientWidth", { configurable: true, value: 200 });
    // The strip's own box, away from the tabs': the edge band is measured against it.
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
      x: 900, y: 10, left: 900, top: 10, width: 200, height: 32, right: 1100, bottom: 42, toJSON: () => ({}),
    } as DOMRect);
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 150, y: 10, left: 150, top: 10, width: 120, height: 32, right: 270, bottom: 42, toJSON: () => ({}),
    } as DOMRect);
    const tab = wrapper.findAll('[role="tab"]')[1];
    tab.element.setPointerCapture = vi.fn();
    const point = vi.spyOn(document, "elementFromPoint").mockReturnValue(wrapper.findAll(".panel-tab")[0].element);
    const frames = (n: number) => new Promise<void>((resolve) => {
      let left = n;
      const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });

    await tab.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 200, clientY: 20 });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 200 });
    await tab.trigger("pointermove", { pointerId: 1, clientX: 1095, clientY: 26 });
    await frames(4);
    expect(strip.scrollLeft).toBe(0); // 没溢出就不动 —— 否则光标在边缘时条带会自己跳

    Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 520 });
    point.mockClear();
    await tab.trigger("pointermove", { pointerId: 1, clientX: 1094, clientY: 26 });
    await frames(3);
    expect(strip.scrollLeft).toBeGreaterThan(20); // 距右端 6px → 每帧 ~10px
    // 光标没动但 tab 在它底下滚过去了 → 落点必须每帧重算，不能等下一次 pointermove
    expect(point.mock.calls.length).toBeGreaterThanOrEqual(3);

    const scrolled = strip.scrollLeft;
    await tab.trigger("pointerup", { pointerId: 1, clientX: 1094, clientY: 26 });
    point.mockClear();
    await frames(4);
    expect(strip.scrollLeft).toBe(scrolled); // 松手就停，不能接着滑
    expect(point.mock.calls.length).toBe(0); // rAF 循环真的被摘掉了，不是“停在原地空转”
    expect(store.activePanel?.tabs.map((tab) => tab.id)).toEqual(["two", "one"]);

    point.mockRestore();
    rect.mockRestore();
    wrapper.unmount();
  });

  it("opens the + menu as a box that belongs to the button, and dismisses it again", async () => {
    // Regression: the menu used to be a native `popover` placed by CSS anchor positioning. WKWebView
    // does not resolve the anchor for a top-layer box, so it opened in the viewport's top-left corner,
    // far from the "+" - and because jsdom has no popover API at all, no test could see it happen.
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.activeThreadId = "add-menu";
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    const setInspectorTab = vi.fn();
    store.setInspectorTab = setInspectorTab;
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    setInspectorTab.mockClear(); // onMounted opens the files tab when the panel has none

    expect(wrapper.find("#panel-add-menu").exists()).toBe(false);
    await wrapper.get("#panel-add-button").trigger("click");
    expect(wrapper.get("#panel-add-button").attributes("aria-expanded")).toBe("true");
    const menu = wrapper.get("#panel-add-menu");
    expect(menu.findAll("button")).toHaveLength(3);
    expect(menu.element.className).toContain("panel-menu");

    // Light dismiss: a pointerdown anywhere outside the button and the box closes it.
    document.dispatchEvent(new Event("pointerdown"));
    await nextTick();
    expect(wrapper.find("#panel-add-menu").exists()).toBe(false);

    // Escape does too (dispatched on the document - the wrapper is not attached to it), and picking an
    // item closes the menu before the tab opens.
    await wrapper.get("#panel-add-button").trigger("click");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(wrapper.find("#panel-add-menu").exists()).toBe(false);
    await wrapper.get("#panel-add-button").trigger("click");
    await wrapper.findAll("#panel-add-menu button")[2].trigger("click");
    expect(wrapper.find("#panel-add-menu").exists()).toBe(false);
    expect(setInspectorTab).toHaveBeenCalledWith("changes");
    wrapper.unmount();
  });

  it("keeps the + menu inside the panel instead of letting it cross the divider", async () => {
    // The panel is 240px wide here and the menu wants 250px, so right-aligning it on the `+` would
    // push its left edge over the divider into the conversation column.
    const rectOf = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const box = this.id === "panel-add-button"
        ? { left: 488, right: 520, top: 8, bottom: 40 }
        : this.classList.contains("panel-workbench")
          ? { left: 300, right: 540, top: 0, bottom: 600 }
          : { left: 0, right: 0, top: 0, bottom: 0 };
      return { ...box, width: box.right - box.left, height: box.bottom - box.top, x: box.left, y: box.top, toJSON: () => ({}) } as DOMRect;
    });
    const widthOf = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      // Behave like a browser that honours max-width, which is what caps the box on a narrow panel.
      return this.classList.contains("panel-menu") ? Math.min(250, parseFloat(this.style.maxWidth) || 250) : 0;
    });
    const heightOf = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(140);
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.activeThreadId = "narrow-panel";
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });

    await wrapper.get("#panel-add-button").trigger("click");
    const menu = wrapper.get("#panel-add-menu").element as HTMLElement;
    expect(menu.style.maxWidth).toBe("224px");
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(300);
    expect(menu.style.left).toBe("308px");
    expect(menu.style.top).toBe("44px");
    wrapper.unmount();
    rectOf.mockRestore();
    widthOf.mockRestore();
    heightOf.mockRestore();
  });

  it("renames a tab from a double click and remembers that the name was chosen", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.activeThreadId = "rename";
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    store.openPanelTab({ id: "term", kind: "terminal", title: tr("inspector.terminal") });
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });

    await wrapper.get('[role="tab"]').trigger("dblclick");
    expect(wrapper.find('[role="tab"]').exists()).toBe(false);
    const input = wrapper.get(".panel-tab-rename");
    await input.setValue("构建终端");
    await input.trigger("keydown", { key: "Enter" });

    expect(store.activePanel?.tabs[0].title).toBe("构建终端");
    expect(store.activePanel?.tabs[0].renamed).toBe(true);
    expect(wrapper.find(".panel-tab-rename").exists()).toBe(false);
    expect(wrapper.get('[role="tab"]').text()).toContain("构建终端");

    await wrapper.get('[role="tab"]').trigger("dblclick");
    await wrapper.get(".panel-tab-rename").trigger("keydown", { key: "Escape" });
    expect(store.activePanel?.tabs[0].title).toBe("构建终端");
    expect(wrapper.find(".panel-tab-rename").exists()).toBe(false);
    wrapper.unmount();
  });

  it("still pins an unpinned file preview on double click instead of renaming it", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{ id: "pin", title: "Pin", workspace: "repo", workspacePath: "D:\\repo", trust: "approve", status: "idle", started: false, generation: 0 }],
      activeThreadId: "pin",
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    repositoryMocks.previewFile.mockResolvedValue({ path: "main.py", content: "print(1)" });
    store.openPanelTab({ id: "pin:main.py", kind: "file", title: "main.py", path: "main.py" });
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });

    await wrapper.get('[role="tab"]').trigger("dblclick");

    expect(wrapper.find(".panel-tab-rename").exists()).toBe(false);
    expect(store.activePanel?.tabs[0].pinned).toBe(true);
    wrapper.unmount();
  });

  it("keeps the directory node mounted while previewing and pinning a file, and toggles it for diffs", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{ id: "tree", title: "Tree", workspace: "repo", workspacePath: "D:\\repo", trust: "approve", status: "idle", started: false, generation: 0 }],
      activeThreadId: "tree",
      repositoryByWorkspace: { "d:/repo": { files: [{ path: "main.py", name: "main.py" }], git: { isRepository: false, files: [] } } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    repositoryMocks.previewFile.mockResolvedValue({ path: "main.py", content: "print(1)" });
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();
    const fileButton = wrapper.get('.file-tree-open');
    await fileButton.trigger('click');
    await flushPromises();
    expect(wrapper.get('.file-tree-open').element).toBe(fileButton.element);
    expect(store.activePanelTab?.pinned).toBe(false);
    await fileButton.trigger('dblclick');
    await flushPromises();
    expect(store.activePanelTab?.pinned).toBe(true);
    expect(wrapper.get(`[aria-label="${tr("inspector.fileTree")}"]`).attributes('aria-expanded')).toBe('true');
    await wrapper.get(`[aria-label="${tr("inspector.fileTree")}"]`).trigger('click');
    expect(wrapper.find('.panel-directory').exists()).toBe(false);
    await store.openRepositoryDiff('main.py', '@@ -1 +1 @@\n-print(1)\n+print(2)', 'message');
    await flushPromises();
    Element.prototype.scrollIntoView = vi.fn();
    await wrapper.get(`[aria-label="${tr("inspector.fileTree")}"]`).trigger('click');
    expect(wrapper.find('.panel-directory').exists()).toBe(true);
    expect(wrapper.find('.repository-diff').exists()).toBe(true);
    wrapper.unmount();
  });

  it("separates Pi write/edit display gutters from source indentation when switching conversation cards", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{ id: "gutter", title: "Gutter", workspace: "repo", workspacePath: "D:\\repo", trust: "approve", status: "idle", started: false, generation: 0 }],
      activeThreadId: "gutter",
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();
    const write = buildToolDiff("write", { path: "main.py", content: "import argparse\n\n    records = []" })!;
    const edit = buildToolDiff("edit", { path: "main.py", oldText: "    records = []", newText: "    records = [1]" }, {
      diff: "    ...\n 12     records = []\n 13 \n-14     records = []\n+14     records = [1]\n 15         return records\n    ...",
    })!;
    for (const [text, expected] of [
      [write.text, [["1", "import argparse"], ["2", ""], ["3", "    records = []"]]],
      [edit.text, [["12", "    records = []"], ["13", ""], ["14", "    records = []"], ["14", "    records = [1]"], ["15", "        return records"]]],
      ["@@ -1 +1 @@\n-123 old\n+456 new", [["1", "123 old"], ["1", "456 new"]]],
      [write.text, [["1", "import argparse"], ["2", ""], ["3", "    records = []"]]],
    ] as const) {
      await store.openRepositoryDiff("main.py", text);
      await flushPromises();
      const rows = wrapper.findAll(".diff-line:not(.is-hunk):not(.is-meta)");
      expect(rows.map((row) => [row.get(".diff-line-number").text(), row.get(".diff-line-text").element.textContent])).toEqual(expected);
      await vi.waitFor(() => expect(wrapper.find(".diff-line-text [class^='tok-']").exists()).toBe(true));
      expect(rows.map((row) => row.get(".diff-line-text").element.textContent)).toEqual(expected.map((row) => row[1]));
    }
    wrapper.unmount();
  });

  it("identifies a recorded conversation diff as this session", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-session-diff", title: "Session diff", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-session-diff",
      ...panelState("thread-session-diff", { kind: "diff", path: "main.go", diff: { path: "main.go", working: "@@ -1 +1 @@\n-old\n+new", session: true } }),
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);

    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(wrapper.get(".diff-section header").text()).toBe("This session");
    expect(wrapper.get('[aria-label="File path"]').text()).toContain("main.go");
    expect(wrapper.classes()).toContain("panel-workbench");
  });

  it("renders repository changes and inserts file mentions", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-1", title: "Audit", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-1",
      repositoryByWorkspace: { "d:/repo": {
        files: [{ path: "README.md", name: "README.md" }, { path: "src/main.go", name: "main.go" }],
        git: {
          isRepository: true,
          branch: "feature/repo-view",
          files: [{ path: "src/main.go", indexStatus: " ", worktreeStatus: "M" }],
        },
      } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    repositoryMocks.diff.mockResolvedValue({
      path: "src/main.go",
      staged: "",
      working: "diff --git a/src/main.go b/src/main.go\n@@ -4,2 +4,2 @@\n keep\n-old\n+new\n\\ No newline at end of file\n",
      content: "",
      binary: false,
      truncated: false,
    });
    repositoryMocks.previewFile.mockResolvedValue({
      path: "README.md", absolutePath: "D:\\repo\\README.md", content: "# Repo", size: 6, binary: false, truncated: false,
    });
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(wrapper.findAll('[role="tab"]')[0].text()).toBe("Files");
    expect(wrapper.find('[title="Show branches"]').exists()).toBe(false);
    expect(wrapper.find('button[title="Preview src/main.go"]').exists()).toBe(true);
    expect(wrapper.get('button[title="Preview src/main.go"]').classes()).toContain("is-changed");
    expect(wrapper.get('button[title="Preview src/main.go"]').attributes("data-status")).toBe("M");
    expect(wrapper.find('button[title="Preview README.md"]').exists()).toBe(true);

    await wrapper.get('button[title="Preview README.md"]').trigger("click");
    await flushPromises();
    expect(repositoryMocks.previewFile).toHaveBeenCalledWith("D:\\repo", "README.md");
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(2);
    expect(wrapper.find(".panel-pathbar").exists()).toBe(true);
    expect(wrapper.get('[aria-label="File path"]').text()).toContain("repo");
    expect(wrapper.get('[aria-label="File path"]').text()).toContain("README.md");
    expect(wrapper.text()).toContain("# Repo");
    await wrapper.get('.panel-tab.is-active .panel-tab-close').trigger("click");
    expect(wrapper.find(".panel-pathbar").exists()).toBe(false);

    expect(wrapper.find(".repository-file-controls").exists()).toBe(false);
    expect(wrapper.find('input[type="search"]').exists()).toBe(true);
    expect(wrapper.find('button[title="Preview README.md"]').exists()).toBe(true);
    expect(wrapper.find('button[title="Preview src/main.go"]').exists()).toBe(true);
    await wrapper.get('button[title="Mention file"]').trigger("click");
    expect(store.activeDraft).toBe("@src/main.go ");

    await wrapper.get('button[title="View diff for src/main.go"]').trigger("click");
    await flushPromises();
    expect(repositoryMocks.diff).toHaveBeenCalledWith("D:\\repo", "src/main.go");
    expect(wrapper.get('[aria-label="Working tree diff"]').text()).toContain("new");
    const deletion = wrapper.get(".diff-line.is-deletion");
    const addition = wrapper.get(".diff-line.is-addition");
    const context = wrapper.findAll(".diff-line").find((line) => line.get(".diff-line-text").text() === "keep");
    expect(context?.get(".diff-line-number").text()).toBe("4");
    expect(deletion.get(".diff-line-number").text()).toBe("5");
    expect(deletion.get(".diff-line-text").text()).toBe("old");
    expect(addition.get(".diff-line-number").text()).toBe("5");
    expect(addition.get(".diff-line-text").text()).toBe("new");
    await vi.waitFor(() => expect(wrapper.find(".diff-line-text [class^='tok-']").exists()).toBe(true));
    expect(wrapper.get('[aria-label="File path"]').text()).toContain("src");
    await wrapper.get(".panel-tab.is-active .panel-tab-close").trigger("click");

    expect(wrapper.find(".context-panel").exists()).toBe(false);
  });

  it("renders renamed, loading, error, and binary diff states", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-2", title: "Assets", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-2",
      repositoryByWorkspace: { "d:/repo": {
        files: [{ path: "new.png", name: "new.png" }],
        git: {
          isRepository: true,
          branch: "main",
          files: [{ path: "new.png", originalPath: "old.png", indexStatus: "R", worktreeStatus: " " }],
        },
      } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(wrapper.find('button[title="Preview new.png"]').exists()).toBe(true);
    expect(wrapper.get('button[title="View diff for new.png"]').text()).toBe("R");
    store.repositoryStaleByWorkspace["d:/repo"] = true;
    store.repositoryErrorByWorkspace["d:/repo"] = "remote repository is disconnected or stale";
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("remote repository is disconnected or stale");
    store.repositoryErrorByWorkspace["d:/repo"] = "";

    store.openPanelTab({ id: "binary", kind: "diff", title: "new.png", path: "new.png", loading: true });
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".repository-diff .is-spinning").exists()).toBe(true);

    store.activePanelTab!.loading = false;
    store.activePanelTab!.error = "diff unavailable";
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("diff unavailable");

    store.activePanelTab!.error = "";
    store.activePanelTab!.diff = {
      path: "new.png", staged: "", working: "", content: "", binary: true, truncated: false,
    };
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("Binary file changed");
  });

  it("does not expose local open actions for a remote preview", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      workspaces: [{ id: "workspace-remote", name: "remote", path: "", kind: "ssh", targetId: "target-remote", remoteRoot: "/srv/repo", trust: "approve" }],
      threads: [{ id: "thread-remote", title: "Remote", workspace: "remote", workspaceId: "workspace-remote", workspacePath: "", trust: "approve", status: "idle", started: false, generation: 0 }],
      activeThreadId: "thread-remote",
      ...panelState("thread-remote", { kind: "file", path: "README.md", preview: { path: "README.md", absolutePath: "", content: "remote", size: 6, binary: false, truncated: false } }),
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);

    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(wrapper.find('button[title="Open file"]').exists()).toBe(false);
    expect(wrapper.find('button[title="Show in file manager"]').exists()).toBe(false);
    expect(wrapper.find(".panel-open-split").exists()).toBe(false);
  });

  it("renders a linked file in the right inspector preview", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-preview", title: "Preview", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-preview",
      ...panelState("thread-preview", { kind: "file", path: "scripts/join_groups.py", preview: {
        path: "scripts/join_groups.py", absolutePath: "D:\\repo\\scripts\\join_groups.py", content: "print('ok')", size: 12, binary: false, truncated: false,
      } }),
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(wrapper.text()).toContain("join_groups.py");
    expect(wrapper.get('[aria-label="File path"]').text()).toContain("scripts");
    expect(wrapper.text()).not.toContain("D:\\repo\\scripts\\join_groups.py");
    expect(wrapper.text()).toContain("print('ok')");
    expect(wrapper.find(".file-preview-tabs").exists()).toBe(false);
    expect(wrapper.find(".file-preview-meta").exists()).toBe(false);
    expect(wrapper.get('[aria-label="File preview content"]').classes()).toEqual(expect.arrayContaining(["rounded-none!", "border-0!"]));
    await wrapper.get('.panel-tab.is-active .panel-tab-close').trigger("click");
    expect(store.activeRepositoryFilePreviewPath).toBe("");
  });

  it("renders media previews without redundant file metadata", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{ id: "thread-media", title: "Media", workspace: "repo", workspacePath: "D:\\repo", trust: "approve", status: "idle", started: false, generation: 0 }],
      activeThreadId: "thread-media",
      ...panelState("thread-media", { kind: "file", path: "image.png", preview: {
        path: "image.png", absolutePath: "D:\\repo\\image.png", mediaType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=", size: 8, binary: true, truncated: false,
      } }),
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    repositoryMocks.previewFile.mockResolvedValue({ path: "README.md", absolutePath: "D:\\repo\\README.md", mediaType: "text/markdown", content: "# Repo", size: 6 });
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(wrapper.get("img.file-media-preview").attributes("src")).toContain("data:image/png");
    expect(wrapper.find(".file-preview-tabs").exists()).toBe(false);
    expect(wrapper.find(".file-preview-meta").exists()).toBe(false);
    await store.openRepositoryFilePreview("README.md");
    await flushPromises();
    expect(repositoryMocks.previewFile).toHaveBeenCalledWith("D:\\repo", "README.md");
    expect(wrapper.text()).toContain("Repo");
    await wrapper.findAll(".markdown-preview-toggle button")[1].trigger("click");
    expect(wrapper.get('[aria-label="File preview content"]').text()).toContain("# Repo");
  });

  it("renders spreadsheet cells and switches worksheets", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{ id: "thread-sheet", title: "Workbook", workspace: "repo", workspacePath: "D:\\repo", trust: "approve", status: "idle", started: false, generation: 0 }],
      activeThreadId: "thread-sheet",
      ...panelState("thread-sheet", { kind: "file", path: "reports/summary.xlsx", preview: {
        path: "reports/summary.xlsx",
        absolutePath: "D:\\repo\\reports\\summary.xlsx",
        mediaType: "application/x-pi-desk-spreadsheet",
        content: JSON.stringify({ sheets: [
          { name: "Summary", columns: 2, rows: [["Name", "Amount"], ["Alpha", "12"]] },
          { name: "Details", columns: 2, rows: [["Item", "State"], ["Browser", "Done"]] },
        ] }),
        size: 128,
        binary: true,
        truncated: false,
      } }),
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);

    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(wrapper.get('[aria-label="File path"]').text()).toContain("reports");
    expect(wrapper.get('[aria-label="File path"]').text()).toContain("summary.xlsx");
    expect(wrapper.get(".spreadsheet-grid").text()).toContain("Alpha");
    expect(wrapper.findAll('.spreadsheet-tabs [role="tab"]')).toHaveLength(2);
    expect(wrapper.findAll('.spreadsheet-tabs [role="tab"]')[0].attributes("aria-selected")).toBe("true");

    await wrapper.findAll('.spreadsheet-tabs [role="tab"]')[1].trigger("click");

    expect(wrapper.get(".spreadsheet-grid").text()).toContain("Browser");
    expect(wrapper.get(".spreadsheet-grid").text()).not.toContain("Alpha");
    expect(wrapper.findAll('.spreadsheet-tabs [role="tab"]')[1].attributes("aria-selected")).toBe("true");
  });

  it("requires a second click before rolling back a session-touched file", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-rollback", title: "Rollback", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-rollback",
      repositoryByWorkspace: { "d:/repo": {
        files: [{ path: "src/main.go", name: "main.go" }],
        git: { isRepository: true, branch: "main", files: [{ path: "src/main.go", indexStatus: " ", worktreeStatus: "M" }] },
      } },
      sessionChangesByThread: { "thread-rollback": [{ path: "src/main.go", editCalls: 1, writeCalls: 0, plan: "revert-edits" }] },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.rollbackSessionFile = vi.fn().mockResolvedValue(undefined);

    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();
    const rollback = wrapper.get('button.file-tree-rollback');
    expect(rollback.attributes("title")).toBe("Roll back session changes");

    await rollback.trigger("click");
    expect(store.rollbackSessionFile).not.toHaveBeenCalled();
    expect(rollback.attributes("title")).toContain("Click again to reverse this session's edits");

    await rollback.trigger("click");
    expect(store.rollbackSessionFile).toHaveBeenCalledWith("src/main.go");
  });

  it("describes the delete plan for session-created files", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-created", title: "Created", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-created",
      repositoryByWorkspace: { "d:/repo": {
        files: [{ path: "notes.md", name: "notes.md" }],
        git: { isRepository: true, branch: "main", files: [{ path: "notes.md", indexStatus: "?", worktreeStatus: "?" }] },
      } },
      sessionChangesByThread: { "thread-created": [{ path: "notes.md", editCalls: 0, writeCalls: 1, plan: "delete" }] },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.rollbackSessionFile = vi.fn().mockResolvedValue(undefined);

    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();
    const rollback = wrapper.get('button.file-tree-rollback');
    expect(rollback.attributes("title")).toBe("Roll back session changes");

    await rollback.trigger("click");
    expect(rollback.attributes("title")).toBe("Click again to delete the file created by this session");
  });
  // ---- Ported onto upstream's tab workbench: workspace-level file tree behaviour -------------

  type RenderedRows = { findAll: (selector: string) => Array<{ attributes: (name: string) => string | undefined }> };
  const previewTitles = (wrapper: RenderedRows) =>
    wrapper.findAll('button[title^="Preview "]').map((node) => node.attributes("title"));

  it("keeps one expansion record per workspace instead of one per tab", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const owned = useAppStore();
    owned.$patch({
      threads: [{ id: "thread-expand", title: "Tree", workspace: "repo", workspacePath: "D:\\repo", trust: "approve", status: "idle", started: false, generation: 0 }],
      activeThreadId: "thread-expand",
      repositoryByWorkspace: { "d:/repo": { files: [{ path: "src/index.ts", name: "index.ts" }, { path: "src/deep/nested.ts", name: "nested.ts" }], git: { isRepository: true, files: [] } } },
    });
    owned.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    owned.scheduleDesktopStateSave = vi.fn();
    const panel = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    // `src` is open by default, `src/deep` is not.
    expect(panel.find('button[title="Preview src/deep/nested.ts"]').exists()).toBe(false);
    await panel.get('button[title="Expand folder"]').trigger("click");
    expect(panel.find('button[title="Preview src/deep/nested.ts"]').exists()).toBe(true);
    expect(owned.repositoryTreeExpandedByWorkspace["d:/repo"]).toEqual({ "src/deep": true });

    // A preview opens its own tab; returning to the files tab must not reset the tree.
    repositoryMocks.previewFile.mockResolvedValue({ path: "src/index.ts", content: "x" });
    await panel.get('button[title="Preview src/index.ts"]').trigger("click");
    await flushPromises();
    const tabs = panel.findAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    await tabs[0]!.trigger("click");
    expect(panel.find('button[title="Preview src/deep/nested.ts"]').exists()).toBe(true);
  });

  it("lists every workspace file up to the backend cap instead of the first 500", async () => {
    const paths = Array.from({ length: 1200 }, (_unused, index) => `src/file-${String(index).padStart(4, "0")}.go`);
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{ id: "thread-cap", title: "Cap", workspace: "repo", workspacePath: "D:\\repo", trust: "approve", status: "idle", started: false, generation: 0 }],
      activeThreadId: "thread-cap",
      repositoryByWorkspace: { "d:/repo": { files: paths.map((path) => ({ path, name: path.split("/").pop() ?? path })), git: { isRepository: true, files: [] } } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(previewTitles(wrapper)).toHaveLength(paths.length);
    expect(wrapper.find(".diff-notice").exists()).toBe(false);
  });

  it("lists git-ignored paths faded, and drops them when the switch is off", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{ id: "thread-ignored", title: "Ignored", workspace: "repo", workspacePath: "D:\\repo", trust: "approve", status: "idle", started: false, generation: 0 }],
      activeThreadId: "thread-ignored",
      repositoryByWorkspace: { "d:/repo": {
        files: [
          { path: "README.md", name: "README.md" },
          { path: ".pi/settings.json", name: "settings.json" },
          { path: ".pi/plans", name: "plans", ignored: true, directory: true },
          { path: ".pi/plans/2026-09-24.md", name: "2026-09-24.md", ignored: true },
        ],
        git: { isRepository: true, files: [] },
      } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    // The folder Git folds into a single `--directory` row still renders, and says why it is faded.
    const folder = wrapper.get('button[title=".pi/plans (git-ignored)"]');
    expect(folder.classes()).toContain("is-ignored");
    // A tracked folder that merely contains an excluded child must not fade.
    expect(wrapper.get('button[title=".pi"]').classes()).not.toContain("is-ignored");
    expect(wrapper.find('button[title="Preview README.md"]').classes()).not.toContain("is-ignored");

    await folder.trigger("click");
    expect(wrapper.get('button[title="Preview .pi/plans/2026-09-24.md (git-ignored)"]').classes()).toContain("is-ignored");

    await wrapper.get(".file-ignored-toggle input").setValue(false);
    expect(store.repositoryShowIgnoredFiles).toBe(false);
    expect(wrapper.find('button[title=".pi/plans (git-ignored)"]').exists()).toBe(false);
    expect(wrapper.find('button[title=".pi"]').exists()).toBe(true);
    expect(wrapper.find('button[title="Preview README.md"]').exists()).toBe(true);
  });

  it("filters the whole file list, including entries beyond the cap", async () => {
    const paths = [
      "src/main.go", "src/WearCaliber.java", "src/WearCaliberTest.java",
      ...Array.from({ length: 600 }, (_unused, index) => `src/filler${index}.go`),
    ];
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{ id: "thread-filter", title: "Filter", workspace: "repo", workspacePath: "D:\\repo", trust: "approve", status: "idle", started: false, generation: 0 }],
      activeThreadId: "thread-filter",
      repositoryByWorkspace: { "d:/repo": { files: paths.map((path) => ({ path, name: path.split("/").pop() ?? path })), git: { isRepository: true, files: [] } } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(previewTitles(wrapper)).toHaveLength(paths.length);

    await wrapper.get(".panel-file-filter input").setValue("wearcaliber");
    expect(previewTitles(wrapper)).toEqual([
      "Preview src/WearCaliber.java",
      "Preview src/WearCaliberTest.java",
    ]);

    await wrapper.get(".panel-file-filter input").setValue("zzzznotatype");
    expect(previewTitles(wrapper)).toEqual([]);
    expect(wrapper.get(".panel-tree-empty").text()).not.toBe("");

    await wrapper.get(".panel-file-filter input").setValue("");
    expect(previewTitles(wrapper)).toHaveLength(paths.length);
  });

  it("finds deep paths by their own file name, not only by short ones", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{ id: "thread-deep", title: "Deep", workspace: "repo", workspacePath: "D:\\repo", trust: "approve", status: "idle", started: false, generation: 0 }],
      activeThreadId: "thread-deep",
      repositoryByWorkspace: { "d:/repo": {
        files: [
          "src/main/java/com/iot/platform/service/WearCaliberService.java",
          "src/main/resources/mapper/WearCaliberMapper.xml",
          "src/main/java/com/iot/platform/service/OrderService.java",
        ].map((path) => ({ path, name: path.split("/").pop() ?? path })),
        git: { isRepository: true, files: [] },
      } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    await wrapper.get(".panel-file-filter input").setValue("wear");
    // The 62-character path used to score below zero against its own name, so only the short mapper
    // path survived a `wear` search.
    expect(previewTitles(wrapper)).toEqual([
      "Preview src/main/java/com/iot/platform/service/WearCaliberService.java",
      "Preview src/main/resources/mapper/WearCaliberMapper.xml",
    ]);
  });

  it("offers an outline of the previewed document and jumps to the heading picked", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-outline", title: "Outline", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-outline",
      ...panelState("thread-outline", { kind: "file", path: "notes/plan.md", markdownRendered: true, preview: {
        path: "notes/plan.md", absolutePath: "D:\\repo\\notes\\plan.md", mediaType: "text/markdown",
        content: "# Plan\n\n## Intro\n\n### Setup\n\n## 深度工作\n\nbody\n", size: 60, binary: false, truncated: false,
      } }),
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    // The outline is opt-in: a 240px inspector cannot spare a permanent rail.
    expect(wrapper.find(".markdown-outline").exists()).toBe(false);
    await wrapper.get(".markdown-outline-toggle").trigger("click");
    const items = wrapper.findAll(".markdown-outline-item");
    expect(items.map((item) => item.text())).toEqual(["Plan", "Intro", "Setup", "深度工作"]);
    // Indent tracks the document's own nesting, and only down to h4 - deeper levels are noise here.
    expect(items.map((item) => item.classes().find((name) => name.startsWith("level-")))).toEqual(["level-0", "level-1", "level-2", "level-1"]);

    await items[2].trigger("click");
    expect(wrapper.findAll(".markdown-outline-item")[2].classes()).toContain("is-active");

    await wrapper.get(".markdown-outline-toggle").trigger("click");
    expect(wrapper.find(".markdown-outline").exists()).toBe(false);
    wrapper.unmount();
  });

  it("holds the outline column steady through a divider drag and catches up on release", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    // What the engine reports for the preview box, and what a direct read answers.
    let measured = 400;
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => measured });
    type Captured = { cb: ResizeObserverCallback; host?: Element };
    const captured: Captured[] = [];
    class TestResizeObserver {
      private record: Captured;
      constructor(callback: ResizeObserverCallback) { this.record = { cb: callback }; captured.push(this.record); }
      observe(element: Element) { this.record.host = element; }
      unobserve() {}
      disconnect() { this.record.host = undefined; }
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const fire = (width: number) => {
      const record = captured.find((item) => item.host?.classList.contains("markdown-preview-host"));
      if (!record) throw new Error("the markdown preview host is not observed");
      record.cb([{ contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    };
    store.$patch({
      threads: [{
        id: "thread-drag", title: "Drag", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-drag",
      ...panelState("thread-drag", { kind: "file", path: "plan.md", markdownRendered: true, preview: {
        path: "plan.md", absolutePath: "D:\\repo\\plan.md", mediaType: "text/markdown",
        content: "# Plan\n\n## Intro\n\n### Setup\n\n## Ship\n", size: 40, binary: false, truncated: false,
      } }),
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();
    try {
      // Narrow: the reader gets no column, and a real measurement keeps it that way.
      expect(wrapper.get(".markdown-preview-host").classes()).not.toContain("has-outline-rail");
      measured = 700;
      fire(700);
      await nextTick();
      expect(wrapper.get(".markdown-preview-host").classes()).toContain("has-outline-rail");

      // The drag: every frame reports a new box, and re-deciding the rail per frame is the stutter.
      // Nothing about the rail is needed until the pointer is released.
      store.setPaneResizing(true);
      measured = 400;
      fire(700);
      fire(400);
      await nextTick();
      expect(wrapper.get(".markdown-preview-host").classes()).toContain("has-outline-rail");

      // Release: the skipped samples are paid for by one direct read, because the box has settled
      // and ResizeObserver will not fire again on its own.
      store.setPaneResizing(false);
      await nextTick();
      expect(wrapper.get(".markdown-preview-host").classes()).not.toContain("has-outline-rail");
      wrapper.unmount();
    } finally {
      vi.unstubAllGlobals();
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
      else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  });

  it("stands the outline up as a column when the pane is wide enough to spare one", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    // No ResizeObserver in this environment, so the panel width is what the decision reads.
    store.inspectorWidth = 700;
    store.$patch({
      threads: [{
        id: "thread-rail", title: "Rail", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-rail",
      ...panelState("thread-rail", { kind: "file", path: "plan.md", markdownRendered: true, preview: {
        path: "plan.md", absolutePath: "D:\\repo\\plan.md", mediaType: "text/markdown",
        content: "# Plan\n\n## Intro\n\n### Setup\n\n## Ship\n", size: 40, binary: false, truncated: false,
      } }),
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    // Wide means the reader wanted the map: it is there without asking.
    expect(wrapper.get(".markdown-preview-host").classes()).toContain("has-outline-rail");
    expect(wrapper.get(".markdown-outline").classes()).toContain("is-rail");
    expect(wrapper.findAll(".markdown-outline-item")).toHaveLength(4);

    // A column of the layout survives a click elsewhere; only the control decides.
    document.dispatchEvent(new Event("pointerdown"));
    await nextTick();
    expect(wrapper.find(".markdown-outline").exists()).toBe(true);
    await wrapper.get(".markdown-outline-toggle").trigger("click");
    expect(wrapper.find(".markdown-outline").exists()).toBe(false);
    wrapper.unmount();
  });

  it("stands the outline up as a rail when the document only arrives after the tab was opened", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.inspectorWidth = 700;
    store.$patch({
      threads: [{
        id: "thread-late", title: "Late", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-late",
      // The tab exists but its content does not: this is what a click in the file tree actually does,
      // and the old watcher on store state never saw the markdown document enter the DOM afterwards.
      ...panelState("thread-late", { kind: "file", path: "plan.md", markdownRendered: true }),
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    repositoryMocks.previewFile.mockResolvedValue({
      path: "plan.md", absolutePath: "D:\\repo\\plan.md", mediaType: "text/markdown",
      content: "# Plan\n\n## Intro\n\n### Setup\n\n## Ship\n", size: 40, binary: false, truncated: false,
    });
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(wrapper.get(".markdown-preview-host").classes()).toContain("has-outline-rail");
    expect(wrapper.findAll(".markdown-outline-item").map((item) => item.text())).toEqual(["Plan", "Intro", "Setup", "Ship"]);
    wrapper.unmount();
  });

  it("dismisses the floating outline on an outside click or Escape, never on a click inside it", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.inspectorWidth = 420;
    store.$patch({
      threads: [{
        id: "thread-float", title: "Float", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-float",
      ...panelState("thread-float", { kind: "file", path: "notes/float.md", markdownRendered: true, preview: {
        path: "notes/float.md", absolutePath: "D:\\repo\\notes\\float.md", mediaType: "text/markdown",
        content: "# Float\n\n## One\n\n## Two\n\n## Three\n", size: 40, binary: false, truncated: false,
      } }),
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    // A narrow pane keeps the list out of the way until it is asked for.
    expect(wrapper.find(".markdown-outline").exists()).toBe(false);
    await wrapper.get(".markdown-outline-toggle").trigger("click");
    expect(wrapper.findAll(".markdown-outline-item")).toHaveLength(4);

    await wrapper.get(".markdown-outline-item").trigger("pointerdown");
    await nextTick();
    expect(wrapper.find(".markdown-outline").exists()).toBe(true);

    document.dispatchEvent(new Event("pointerdown"));
    await nextTick();
    expect(wrapper.find(".markdown-outline").exists()).toBe(false);

    await wrapper.get(".markdown-outline-toggle").trigger("click");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(wrapper.find(".markdown-outline").exists()).toBe(false);
    wrapper.unmount();
  });

  it("hides the outline control from a document with no headings", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-noheadings", title: "Plain", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-noheadings",
      ...panelState("thread-noheadings", { kind: "file", path: "notes/plain.md", markdownRendered: true, preview: {
        path: "notes/plain.md", absolutePath: "D:\\repo\\notes\\plain.md", mediaType: "text/markdown",
        content: "just prose\n\n- and a list\n", size: 22, binary: false, truncated: false,
      } }),
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(wrapper.find(".markdown-outline-toggle").exists()).toBe(false);
    wrapper.unmount();
  });

  it("searches a rendered Markdown preview and keeps exactly one hit active", async () => {
    const scrolled: Element[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this); }) as typeof original;
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-find", title: "Find", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-find",
      ...panelState("thread-find", { kind: "file", path: "notes/find.md", markdownRendered: true, preview: {
        path: "notes/find.md", absolutePath: "D:\\repo\\notes\\find.md", mediaType: "text/markdown",
        content: "# Alpha\n\nfirst alpha\n\nsecond ALPHA\n\nnothing here\n", size: 44, binary: false, truncated: false,
      } }),
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    // No chip in the preview bar: the reader asked for the shortcut, not for another control
    // competing with 大纲 / 返回 for that row.
    expect(wrapper.find(".markdown-search-toggle").exists()).toBe(false);
    expect(wrapper.find(".markdown-search").exists()).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    await nextTick();
    await wrapper.get(".search-popover-input").setValue("alpha");
    await wrapper.get(".search-popover-input").trigger("keydown", { key: "Enter" });
    await nextTick();

    // Three hits, one of them inside the heading - counting comes from the rendered document, so the
    // number cannot disagree with what the reader can see.
    expect(wrapper.findAll(".markdown-search-hit")).toHaveLength(3);
    const active = () => wrapper.findAll(".markdown-search-hit.is-active");
    expect(active()).toHaveLength(1);
    expect(active()[0].element).toBe(wrapper.findAll(".markdown-search-hit")[0].element);
    expect(wrapper.get(".search-popover-count").text()).toBe("1 / 3");

    const next = wrapper.findAll(".search-popover-control")[1];
    // Hit 0 is the one inside the `<h1>` - document order, not paragraph order.
    await next.trigger("click");
    expect(active()[0].text()).toBe("alpha");
    expect(wrapper.get(".search-popover-count").text()).toBe("2 / 3");
    expect(scrolled.length).toBeGreaterThan(0);

    await next.trigger("click");
    expect(active()[0].text()).toBe("ALPHA");
    // The list wraps instead of dead-ending at the last hit.
    await next.trigger("click");
    expect(wrapper.get(".search-popover-count").text()).toBe("1 / 3");
    expect(active()[0].text()).toBe("Alpha");

    // Escape with the caret outside the field still dismisses the box - and takes the marks with it.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(wrapper.find(".markdown-search").exists()).toBe(false);
    expect(wrapper.findAll(".markdown-search-hit")).toHaveLength(0);
    HTMLElement.prototype.scrollIntoView = original;
    wrapper.unmount();
  });

  it("follows a Markdown link into a second document, then goes back to the first", async () => {
    const scrolled: string[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this.id); }) as typeof original;
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-jump", title: "Jump", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-jump",
      ...panelState("thread-jump", { kind: "file", path: "notes/a.md", markdownRendered: true, preview: {
        path: "notes/a.md", absolutePath: "D:\\repo\\notes\\a.md", mediaType: "text/markdown",
        content: "# A\n\n[goto b](b.md#target)\n", size: 24, binary: false, truncated: false,
      } }),
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    repositoryMocks.previewFile.mockImplementation((_root: string, path: string) => Promise.resolve({
      path, absolutePath: `D:\\repo\\${path}`, mediaType: "text/markdown",
      content: path.endsWith("b.md") ? "# B\n\n## Target\n\nthe section\n" : "# other\n", size: 40, binary: false, truncated: false,
    }));
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(store.activePanel?.tabs).toHaveLength(1);

    await wrapper.get(".markdown-body a").trigger("click");
    await flushPromises();
    // The link opened a second document in a second tab; the first one is still there.
    expect(store.activeRepositoryFilePreviewPath).toBe("notes/b.md");
    expect(store.activePanel?.tabs.map((tab) => tab.path)).toEqual(["notes/a.md", "notes/b.md"]);
    expect(wrapper.text()).toContain("the section");
    // `b.md#target` is only useful if the reader lands on the section, not on the top of the file.
    // The jump is deliberately one macrotask late (it has to beat the per-tab scroll restore), so
    // flushPromises alone cannot observe it.
    await vi.waitFor(() => expect(scrolled.some((id) => id.endsWith("-target"))).toBe(true), { timeout: 2000 });

    const back = wrapper.get(".markdown-link-back");
    expect(back.text()).toContain("a.md");
    await back.trigger("click");
    expect(store.activeRepositoryFilePreviewPath).toBe("notes/a.md");
    expect(store.activePanelTab?.returnToTabId).toBeUndefined();
    // The trail is one-way: going back must leave a "back" button waiting on the source document.
    // Both documents stay open: going back closes nothing, and the trail itself is cleared.
    expect(store.activePanel?.tabs).toHaveLength(2);
    expect(wrapper.find(".markdown-link-back").exists()).toBe(false);
    wrapper.unmount();
    HTMLElement.prototype.scrollIntoView = original;
  });

  it("restores the file tree scroll offset when returning to the tab", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{ id: "thread-scroll", title: "Scroll", workspace: "repo", workspacePath: "D:\\repo", trust: "approve", status: "idle", started: false, generation: 0 }],
      activeThreadId: "thread-scroll",
      repositoryByWorkspace: { "d:/repo": {
        files: [{ path: "src/index.ts", name: "index.ts" }, { path: "src/deep/nested.ts", name: "nested.ts" }],
        git: { isRepository: true, files: [] },
      } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    store.scheduleDesktopStateSave = vi.fn();
    repositoryMocks.previewFile.mockResolvedValue({ path: "src/index.ts", content: "x" });
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    await flushPromises();

    const tree = wrapper.get(".panel-file-tree").element as HTMLElement;
    tree.scrollTop = 640;
    // `@scroll.capture` on the panel catches this even though scroll events do not bubble.
    tree.dispatchEvent(new Event("scroll"));
    expect(store.activePanelTab?.scroll?.[".panel-file-tree"]).toEqual([0, 640]);

    await wrapper.get('button[title="Preview src/index.ts"]').trigger("click");
    await flushPromises();
    const tabs = wrapper.findAll('[role="tab"]');
    await tabs[0]!.trigger("click");
    await flushPromises();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect((wrapper.get(".panel-file-tree").element as HTMLElement).scrollTop).toBe(640);
  });

});
