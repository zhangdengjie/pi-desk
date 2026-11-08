import { Create, Enabled, List, Prune, Remove } from "../../bindings/pi-desk/internal/appservice/worktreeservice";
import type {
  WorktreeCreateRequest,
  WorktreeListRequest,
  WorktreePruneResult,
  WorktreeRemoveResult,
  WorktreeRequest,
  WorktreeSummary,
} from "../../bindings/pi-desk/internal/domain";

export const worktreeService = {
  enabled: (): Promise<boolean> => Enabled(),
  create: (request: WorktreeCreateRequest): Promise<WorktreeSummary> => Create(request),
  list: (request: WorktreeListRequest): Promise<WorktreeSummary[] | null> => List(request),
  remove: (request: WorktreeRequest): Promise<WorktreeRemoveResult> => Remove(request),
  prune: (request: WorktreeListRequest): Promise<WorktreePruneResult> => Prune(request),
};
