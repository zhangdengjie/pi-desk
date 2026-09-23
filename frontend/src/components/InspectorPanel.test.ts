import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../stores/app";
import InspectorPanel from "./InspectorPanel.vue";

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
describe("InspectorPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("identifies a recorded conversation diff as this session", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-session-diff", title: "Session diff", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-session-diff",
      repositoryDiffPathByWorkspace: { "d:/repo": "main.go" },
      repositoryDiffByWorkspace: { "d:/repo": { path: "main.go", working: "@@ -1 +1 @@\n-old\n+new", session: true } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);

    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });

    expect(wrapper.get(".diff-section header").text()).toBe("This session");
    expect(wrapper.get(".diff-stats").text()).toBe("+1-1");
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

    // layout.css owns the tree geometry; a Tailwind utility bundle on these elements out-ranks it
    // (Tailwind is imported `important`) and flattened every level back to the left margin.
    expect(wrapper.get(".file-tree-node").classes()).toEqual(["file-tree-node"]);
    for (const row of wrapper.findAll(".file-tree-row")) expect(row.classes()).toEqual(["file-tree-row"]);

    expect(wrapper.findAll('[role="tab"]')[0].text()).toBe("Files");
    expect(wrapper.find('[title="Show branches"]').exists()).toBe(false);
    expect(wrapper.find('button[title="Preview src/main.go"]').exists()).toBe(true);
    expect(wrapper.get('button[title="Preview src/main.go"]').classes()).toContain("is-changed");
    expect(wrapper.get('button[title="Preview src/main.go"]').attributes("data-status")).toBe("M");
    expect(wrapper.find('button[title="Preview README.md"]').exists()).toBe(true);

    await wrapper.get('button[title="Preview README.md"]').trigger("click");
    await flushPromises();
    expect(repositoryMocks.previewFile).toHaveBeenCalledWith("D:\\repo", "README.md");
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(4);
    expect(wrapper.find(".inspector-file-header").exists()).toBe(true);
    expect(wrapper.text()).toContain("# Repo");
    await wrapper.get('button[title="Close file preview"]').trigger("click");
    expect(wrapper.find(".inspector-file-header").exists()).toBe(false);

    expect(wrapper.find(".repository-file-controls").exists()).toBe(false);
    // The panel has exactly one search control now: the file filter added on top of the tree.
    expect(wrapper.findAll('input[type="search"]')).toHaveLength(1);
    expect(wrapper.find('button[title="Preview README.md"]').exists()).toBe(true);
    expect(wrapper.find('button[title="Preview src/main.go"]').exists()).toBe(true);
    await wrapper.get('button[title="Mention file"]').trigger("click");
    expect(store.activeDraft).toBe("@src/main.go ");

    await wrapper.get('button[title="View diff for src/main.go"]').trigger("click");
    await flushPromises();
    expect(repositoryMocks.diff).toHaveBeenCalledWith("D:\\repo", "src/main.go");
    expect(wrapper.get('[aria-label="Working tree diff"]').text()).toContain("+new");
    const deletion = wrapper.get(".diff-line.is-deletion");
    const addition = wrapper.get(".diff-line.is-addition");
    const context = wrapper.findAll(".diff-line").find((line) => line.get(".diff-line-text").text() === "keep");
    expect(context?.get(".diff-line-number--old").text()).toBe("4");
    expect(context?.get(".diff-line-number--new").text()).toBe("4");
    expect(deletion.get(".diff-line-number--old").text()).toBe("5");
    expect(deletion.get(".diff-line-number--new").text()).toBe("");
    expect(deletion.get(".diff-line-marker").text()).toBe("−");
    expect(deletion.get(".diff-line-text").text()).toBe("old");
    expect(addition.get(".diff-line-number--old").text()).toBe("");
    expect(addition.get(".diff-line-number--new").text()).toBe("5");
    expect(addition.get(".diff-line-text").text()).toBe("new");
    expect(wrapper.get(".diff-stats").text()).toBe("+1-1");
    await wrapper.get('button[title="Back to changes"]').trigger("click");

    await wrapper.findAll('[role="tab"]')[1].trigger("click");
    expect(wrapper.text()).toContain("D:\\repo");
    const contextRows = wrapper.findAll(".context-panel dl > div");
    expect(contextRows[2].text()).toContain("SessionAudit");
    expect(contextRows[3].text()).toContain("Session IDCreated on first prompt");
    expect(wrapper.text()).not.toContain("All files");
  });

  it("restores the file tree scroll offset after closing a preview", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-scroll", title: "Scroll", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-scroll",
      repositoryByWorkspace: { "d:/repo": {
        files: [
          { path: "src/index.ts", name: "index.ts" },
          { path: "src/deep/nested.ts", name: "nested.ts" },
        ],
        git: { isRepository: true, files: [] },
      } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    repositoryMocks.previewFile.mockResolvedValue({
      path: "src/index.ts", absolutePath: "D:\\repo\\src\\index.ts", content: "x", size: 1, binary: false, truncated: false,
    });
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });

    const tree = wrapper.get(".file-tree").element as HTMLElement;
    tree.scrollTop = 640;
    tree.dispatchEvent(new Event("scroll"));
    expect(store.repositoryTreeScrollTopByWorkspace["d:/repo"]).toBe(640);

    // Opening a preview unmounts the element entirely, which is what used to lose the offset.
    await wrapper.get('button[title="Preview src/index.ts"]').trigger("click");
    await flushPromises();
    expect(wrapper.find(".file-tree").exists()).toBe(false);

    await wrapper.get('button[title="Close file preview"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect((wrapper.get(".file-tree").element as HTMLElement).scrollTop).toBe(640);
  });

  it("keeps the tree expanded across opening and closing a file preview", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-tree", title: "Tree", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-tree",
      repositoryByWorkspace: { "d:/repo": {
        files: [
          { path: "src/index.ts", name: "index.ts" },
          { path: "src/deep/nested.ts", name: "nested.ts" },
        ],
        git: { isRepository: true, files: [] },
      } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    repositoryMocks.previewFile.mockResolvedValue({
      path: "src/index.ts", absolutePath: "D:\\repo\\src\\index.ts", content: "x", size: 1, binary: false, truncated: false,
    });
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });

    // `src` starts open, `src/deep` does not.
    expect(wrapper.find('button[title="Preview src/deep/nested.ts"]').exists()).toBe(false);
    await wrapper.get('button[title="Expand folder"]').trigger("click");
    expect(wrapper.find('button[title="Preview src/deep/nested.ts"]').exists()).toBe(true);

    // Opening a preview unmounts the whole tree; the expansion has to survive that round trip.
    await wrapper.get('button[title="Preview src/index.ts"]').trigger("click");
    await flushPromises();
    expect(wrapper.find(".inspector-file-header").exists()).toBe(true);
    await wrapper.get('button[title="Close file preview"]').trigger("click");

    expect(wrapper.find('button[title="Preview src/deep/nested.ts"]').exists()).toBe(true);
    expect(store.repositoryTreeExpandedByWorkspace["d:/repo"]).toEqual({ "src/deep": true });
  });

  it("lists every workspace file up to the backend cap instead of the first 500", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    const paths = Array.from({ length: 1200 }, (_unused, index) => `src/file-${String(index).padStart(4, "0")}.go`);
    paths.push("收尾.md");
    store.$patch({
      threads: [{
        id: "thread-cap", title: "Cap", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-cap",
      repositoryByWorkspace: { "d:/repo": {
        files: paths.map((path) => ({ path, name: path.split("/").pop() ?? path })),
        git: { isRepository: true, files: [] },
      } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);

    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });

    // The old `slice(0, 500)` cut the list alphabetically, so the tail was unreachable — and that
    // tail always contained every non-ASCII filename.
    const previewed = () => wrapper.findAll('button[title^="Preview "]').map((node) => node.attributes("title"));
    expect(previewed()).toHaveLength(1201);
    expect(previewed()).toContain("Preview src/file-0900.go");
    expect(previewed()).toContain("Preview 收尾.md");
    expect(wrapper.find(".diff-notice").exists()).toBe(false);
  });

  it("lists git-ignored paths faded, and drops them when the switch is off", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-ignored", title: "Ignored", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-ignored",
      repositoryByWorkspace: { "d:/repo": {
        files: [
          { path: "README.md", name: "README.md" },
          { path: ".pi/settings.json", name: "settings.json" },
          { path: ".pi/plans", name: "plans", ignored: true, directory: true },
          { path: ".pi/plans/2026-09-23.md", name: "2026-09-23.md", ignored: true },
        ],
        git: { isRepository: true, files: [] },
      } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);

    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });

    // The folder Git folds into a single `--directory` row still renders, and says why it is faded.
    const folder = wrapper.get('span[title=".pi/plans (git-ignored)"]');
    expect(folder.classes()).toContain("is-ignored");
    // A tracked folder that merely contains an excluded child must not fade.
    expect(wrapper.get('span[title=".pi"]').classes()).not.toContain("is-ignored");
    expect(wrapper.find('button[title="Preview README.md"]').classes()).not.toContain("is-ignored");

    await folder.trigger("click");
    const plan = wrapper.get('button[title="Preview .pi/plans/2026-09-23.md (git-ignored)"]');
    expect(plan.classes()).toContain("is-ignored");

    await wrapper.get(".file-ignored-toggle input").setValue(false);
    expect(store.repositoryShowIgnoredFiles).toBe(false);
    expect(wrapper.find('span[title=".pi/plans (git-ignored)"]').exists()).toBe(false);
    expect(wrapper.find('span[title=".pi"]').exists()).toBe(true);
    expect(wrapper.find('button[title="Preview README.md"]').exists()).toBe(true);
  });

  it("filters the whole file list, including entries beyond the cap", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    const paths = [
      "src/main.go", "src/WearCaliber.java", "src/WearCaliberTest.java",
      ...Array.from({ length: 600 }, (_unused, index) => `src/filler${index}.go`),
    ];
    store.$patch({
      threads: [{
        id: "thread-filter", title: "Filter", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
      activeThreadId: "thread-filter",
      repositoryByWorkspace: { "d:/repo": {
        files: paths.map((path) => ({ path, name: path.split("/").pop() ?? path })),
        git: { isRepository: true, files: [] },
      } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);

    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    const previewed = () => wrapper.findAll('button[title^="Preview "]').map((node) => node.attributes("title"));
    // Nothing is hidden, so the panel shows no truncation notice at all.
    expect(wrapper.find(".diff-notice").exists()).toBe(false);
    expect(previewed()).toHaveLength(paths.length);

    await wrapper.get(".file-filter-row input").setValue("wearcaliber");

    expect(previewed()).toEqual([
      "Preview src/WearCaliber.java",
      "Preview src/WearCaliberTest.java",
    ]);
    expect(wrapper.get(".file-filter-count").text()).toContain("2");

    await wrapper.get(".file-filter-row input").setValue("zzzznotatype");
    expect(previewed()).toEqual([]);
    expect(wrapper.get(".repository-state").text()).not.toBe("");

    await wrapper.get(".file-filter-row input").setValue("");
    expect(previewed()).toHaveLength(paths.length);
  });

  it("finds deep paths by their own file name, not only by short ones", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{
        id: "thread-deep", title: "Deep", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
        status: "idle", started: false, generation: 0,
      }],
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

    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });
    const expandFolders = async () => {
      for (let round = 0; round < 6; round += 1) {
        const toggles = wrapper.findAll('button[title="Expand folder"]');
        if (!toggles.length) return;
        for (const toggle of toggles) await toggle.trigger("click");
      }
    };
    await wrapper.get(".file-filter-row input").setValue("wear");
    await expandFolders();

    // The 62-character path used to score below zero against its own name, so only the short
    // mapper path survived a `wear` search.
    expect(wrapper.findAll('button[title^="Preview "]').map((node) => node.attributes("title"))).toEqual([
      "Preview src/main/java/com/iot/platform/service/WearCaliberService.java",
      "Preview src/main/resources/mapper/WearCaliberMapper.xml",
    ]);

    await wrapper.get(".file-filter-row input").setValue("src/main/resources");
    expect(wrapper.get(".file-filter-count").text()).toContain("1");
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

    expect(wrapper.find('button[title="Preview new.png"]').exists()).toBe(true);
    expect(wrapper.get('button[title="View diff for new.png"]').text()).toBe("R");
    store.repositoryStaleByWorkspace["d:/repo"] = true;
    store.repositoryErrorByWorkspace["d:/repo"] = "remote repository is disconnected or stale";
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("Repository data is stale");
    expect(wrapper.get('button[title="View diff for new.png"]').text()).toBe("R");

    store.repositoryDiffPathByWorkspace["d:/repo"] = "new.png";
    store.repositoryDiffLoadingByWorkspace["d:/repo"] = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".repository-diff .is-spinning").exists()).toBe(true);

    store.repositoryDiffLoadingByWorkspace["d:/repo"] = false;
    store.repositoryDiffErrorByWorkspace["d:/repo"] = "diff unavailable";
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("diff unavailable");

    store.repositoryDiffErrorByWorkspace["d:/repo"] = "";
    store.repositoryDiffByWorkspace["d:/repo"] = {
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
      repositoryFilePreviewPathByThread: { "thread-remote": "README.md" },
      repositoryFilePreviewByThread: { "thread-remote": { path: "README.md", absolutePath: "", content: "remote", size: 6, binary: false, truncated: false } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);

    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });

    expect(wrapper.find('button[title="Open file"]').exists()).toBe(false);
    expect(wrapper.find('button[title="Show in file manager"]').exists()).toBe(false);
    store.closeRepositoryFilePreview();
    store.inspectorTab = "context";
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("/srv/repo");
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
      repositoryFilePreviewPathByThread: { "thread-preview": "scripts/join_groups.py" },
      repositoryFilePreviewByThread: { "thread-preview": {
        path: "scripts/join_groups.py", absolutePath: "D:\\repo\\scripts\\join_groups.py", content: "print('ok')", size: 12, binary: false, truncated: false,
      } },
      repositoryFilePreviewLineByThread: { "thread-preview": 7 },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });

    expect(wrapper.text()).toContain("join_groups.py");
    expect(wrapper.text()).not.toContain("D:\\repo\\scripts\\join_groups.py");
    expect(wrapper.text()).toContain("print('ok')");
    expect(wrapper.text()).toContain(":7");
    expect(wrapper.find(".file-preview-tabs").exists()).toBe(false);
    expect(wrapper.find(".file-preview-meta").exists()).toBe(false);
    expect(wrapper.get('[aria-label="File preview content"]').classes()).toEqual(expect.arrayContaining(["rounded-none!", "border-0!"]));
    await wrapper.get('button[title="Close file preview"]').trigger("click");
    expect(store.activeRepositoryFilePreviewPath).toBe("");
  });

  it("renders media previews without redundant file metadata", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    store.$patch({
      threads: [{ id: "thread-media", title: "Media", workspace: "repo", workspacePath: "D:\\repo", trust: "approve", status: "idle", started: false, generation: 0 }],
      activeThreadId: "thread-media",
      repositoryFileTabsByThread: { "thread-media": ["README.md", "image.png"] },
      repositoryFilePreviewPathByThread: { "thread-media": "image.png" },
      repositoryFilePreviewByThread: { "thread-media": {
        path: "image.png", absolutePath: "D:\\repo\\image.png", mediaType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=", size: 8, binary: true, truncated: false,
      } },
    });
    store.refreshActiveRepository = vi.fn().mockResolvedValue(undefined);
    repositoryMocks.previewFile.mockResolvedValue({ path: "README.md", absolutePath: "D:\\repo\\README.md", mediaType: "text/markdown", content: "# Repo", size: 6 });
    const wrapper = mount(InspectorPanel, { global: { plugins: [pinia] } });

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
    const rollback = wrapper.get('button.file-tree-rollback');
    expect(rollback.attributes("title")).toBe("Roll back session changes");

    await rollback.trigger("click");
    expect(rollback.attributes("title")).toBe("Click again to delete the file created by this session");
  });
});
