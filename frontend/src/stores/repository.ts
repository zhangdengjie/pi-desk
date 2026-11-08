import { defineStore } from "pinia";
import type { RepositorySnapshot } from "../services/repository";

/** Repository snapshots and file-tree UI state, keyed by workspace path. */
export const useRepositoryStore = defineStore("repository", {
  state: () => ({
    repositoryByWorkspace: {} as Record<string, RepositorySnapshot | undefined>,
    repositoryLoadingByWorkspace: {} as Record<string, boolean>,
    repositoryErrorByWorkspace: {} as Record<string, string>,
    repositoryStaleByWorkspace: {} as Record<string, boolean>,
    repositoryTreeExpandedByWorkspace: {} as Record<string, Record<string, boolean>>,
    repositoryShowIgnoredFiles: true,
    repositoryRefreshGenerationByWorkspace: {} as Record<string, number>,
  }),
});
