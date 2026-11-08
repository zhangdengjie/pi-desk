import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../stores/app";
import { useWorkspaceStore } from "../stores/workspace";
import DeleteSessionDialog from "./DeleteSessionDialog.vue";

// R1b workspace store split: tests still seed the app store by name. Route
// workspace-owned fields to their new owner and patch the rest as before.
function patchApp(store: any, partial: any) {
  const { threads, workspaces, workspaceApplications, workspaceApplication, ...rest } = partial;
  store.$patch(rest);
  const workspace = useWorkspaceStore();
  if (threads !== undefined) workspace.threads = threads;
  if (workspaces !== undefined) workspace.workspaces = workspaces;
  if (workspaceApplications !== undefined) workspace.workspaceApplications = workspaceApplications;
  if (workspaceApplication !== undefined) workspace.workspaceApplication = workspaceApplication;
}

vi.mock("../services/agent", () => ({ agentService: {}, onPiEvent: () => () => undefined }));
vi.mock("../services/catalog", () => ({ catalogService: {} }));
vi.mock("../services/desktop", () => ({ getBootstrapState: vi.fn() }));
vi.mock("../services/repository", () => ({ repositoryService: {} }));

describe("DeleteSessionDialog", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("requires confirmation and displays the recovery path after deletion", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAppStore();
    patchApp(store, {
      deleteDialogOpen: true,
      deleteThreadId: "thread-1",
      deleteSessionTitle: "Runtime audit",
      deleteHasSession: true,
      activeThreadId: "thread-1",
      threads: [{
        id: "thread-1", title: "Runtime audit", workspace: "repo", workspacePath: "D:\\repo", trust: "deny",
        status: "idle", started: false, generation: 0, sessionFile: "one.jsonl",
      }],
    });
    store.confirmDeleteSession = vi.fn().mockImplementation(async () => {
      store.deletedRecoveryPath = "one.jsonl.deleted-test";
    });
    const wrapper = mount(DeleteSessionDialog, { global: { plugins: [pinia] } });

    expect(wrapper.text()).toContain("Delete Pi session?");
    await wrapper.get(".danger-button").trigger("click");
    expect(store.confirmDeleteSession).toHaveBeenCalledOnce();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("one.jsonl.deleted-test");
    expect(wrapper.text()).toContain("Session removed");
  });
});
