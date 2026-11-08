import { defineStore } from "pinia";
import type { WorkspaceApplication } from "../../bindings/pi-desk/internal/domain";
import type { ThreadSummary, WorkspaceSummary } from "./app";

/**
 * Workspace / thread catalog. `app.ts` keeps same-named getters as a facade
 * while the rest of the store is split in later cuts.
 */
export const useWorkspaceStore = defineStore("workspace", {
  state: () => ({
    threads: [] as ThreadSummary[],
    workspaces: [] as WorkspaceSummary[],
    workspaceApplications: [] as WorkspaceApplication[],
    workspaceApplication: "",
  }),
});
