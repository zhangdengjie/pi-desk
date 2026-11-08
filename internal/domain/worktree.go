package domain

// WorktreeCreateRequest asks the desktop to create (or reuse) the worktree
// bound to a Task. TaskID may be a thread identity before the Task row exists;
// the branch/path stay stable once created.
type WorktreeCreateRequest struct {
	WorkspaceID string `json:"workspaceId"`
	TaskID      string `json:"taskId"`
	BaseRef     string `json:"baseRef,omitempty"`
}

type WorktreeListRequest struct {
	WorkspaceID string `json:"workspaceId"`
}

type WorktreeRequest struct {
	WorkspaceID string `json:"workspaceId,omitempty"`
	TaskID      string `json:"taskId,omitempty"`
	Path        string `json:"path,omitempty"`
}

type WorktreeSummary struct {
	TaskID      string `json:"taskId"`
	Slug        string `json:"slug"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	Path        string `json:"path"`
	Branch      string `json:"branch"`
	BaseRef     string `json:"baseRef,omitempty"`
	Head        string `json:"head,omitempty"`
	Managed     bool   `json:"managed"`
	Dirty       bool   `json:"dirty,omitempty"`
	Unmerged    int    `json:"unmerged,omitempty"`
}

type WorktreeRemoveResult struct {
	Path       string `json:"path"`
	Branch     string `json:"branch"`
	Removed    bool   `json:"removed"`
	Orphaned   bool   `json:"orphaned"`
	BranchKept bool   `json:"branchKept"`
	Reason     string `json:"reason,omitempty"`
}

type WorktreePruneResult struct {
	Removed []string `json:"removed"`
}
