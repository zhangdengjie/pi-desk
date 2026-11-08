package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAddWorktreeInheritsTrustAndPersists(t *testing.T) {
	root := t.TempDir()
	parentPath := filepath.Join(root, "repo")
	childPath := filepath.Join(parentPath, ".worktrees", "task-abc")
	if err := os.MkdirAll(childPath, 0o755); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(root, "state.json")
	catalog := NewCatalog(statePath)

	parent, err := catalog.Add(parentPath, "approve")
	if err != nil {
		t.Fatal(err)
	}
	child, err := catalog.AddWorktree(parent.ID, childPath, "pidesk/task-abc", "task_abc")
	if err != nil {
		t.Fatal(err)
	}
	canonicalChild, err := CanonicalDirectory(childPath)
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentWorkspaceID != parent.ID || child.WorktreeBranch != "pidesk/task-abc" || child.WorktreeTaskID != "task_abc" {
		t.Fatalf("unexpected worktree record: %#v", child)
	}
	if child.Path != canonicalChild || child.Trust != "approve" {
		t.Fatalf("worktree path/trust not inherited: %#v", child)
	}

	if _, err := catalog.Add(parentPath, "deny"); err != nil {
		t.Fatal(err)
	}
	child, err = catalog.ResolveID(child.ID)
	if err != nil {
		t.Fatal(err)
	}
	if child.Trust != "deny" {
		t.Fatalf("child trust was not propagated: %#v", child)
	}

	reloaded := NewCatalog(statePath)
	child, err = reloaded.ResolveID(child.ID)
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentWorkspaceID != parent.ID || child.WorktreeBranch != "pidesk/task-abc" || child.WorktreeTaskID != "task_abc" || child.Trust != "deny" {
		t.Fatalf("worktree metadata did not persist: %#v", child)
	}
}

func TestAddWorktreeRejectsNestedAndDuplicatePaths(t *testing.T) {
	root := t.TempDir()
	parentPath := filepath.Join(root, "repo")
	childPath := filepath.Join(parentPath, ".worktrees", "task-one")
	grandchildPath := filepath.Join(parentPath, ".worktrees", "task-two")
	if err := os.MkdirAll(childPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(grandchildPath, 0o755); err != nil {
		t.Fatal(err)
	}
	catalog := NewCatalog(filepath.Join(root, "state.json"))
	parent, err := catalog.Add(parentPath, "approve")
	if err != nil {
		t.Fatal(err)
	}
	child, err := catalog.AddWorktree(parent.ID, childPath, "pidesk/task-one", "task_one")
	if err != nil {
		t.Fatal(err)
	}
	again, err := catalog.AddWorktree(parent.ID, childPath, "pidesk/task-one", "task_one")
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != child.ID {
		t.Fatalf("idempotent AddWorktree created a second record: %#v", again)
	}
	if _, err := catalog.AddWorktree(parent.ID, childPath, "pidesk/task-other", "task_other"); err == nil {
		t.Fatal("expected duplicate path error")
	}
	if _, err := catalog.AddWorktree(child.ID, grandchildPath, "pidesk/task-two", "task_two"); err == nil {
		t.Fatal("expected nested worktree error")
	}
	if _, err := catalog.AddWorktree("workspace-missing", grandchildPath, "pidesk/task-two", "task_two"); err == nil {
		t.Fatal("expected missing parent error")
	}
	if _, err := catalog.AddWorktree(parent.ID, grandchildPath, "", "task_two"); err == nil {
		t.Fatal("expected missing branch error")
	}
}

func TestRemoveParentRemovesWorktreeThreadsAndSchedules(t *testing.T) {
	root := t.TempDir()
	parentPath := filepath.Join(root, "repo")
	childPath := filepath.Join(parentPath, ".worktrees", "task-child")
	if err := os.MkdirAll(childPath, 0o755); err != nil {
		t.Fatal(err)
	}
	catalog := NewCatalog(filepath.Join(root, "state.json"))
	parent, err := catalog.Add(parentPath, "approve")
	if err != nil {
		t.Fatal(err)
	}
	child, err := catalog.AddWorktree(parent.ID, childPath, "pidesk/task-child", "task_child")
	if err != nil {
		t.Fatal(err)
	}
	if err := catalog.SaveDesktop(DesktopRecord{
		Threads: []ThreadRecord{{
			ID: "thread-child", Title: "child", WorkspaceID: child.ID,
			WorkspacePath: child.Path, Trust: "approve", Status: "idle",
		}},
		ScheduledTasks: []ScheduledTaskRecord{{
			ID: "schedule-child", Name: "child", Prompt: "run", WorkspaceID: child.ID,
			Frequency: "once", RunAt: "2026-11-10T00:00:00Z", Enabled: false,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := catalog.Remove(parent.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := catalog.ResolveID(child.ID); err == nil {
		t.Fatal("child worktree survived parent removal")
	}
	desktop, err := catalog.Desktop()
	if err != nil {
		t.Fatal(err)
	}
	if len(desktop.Threads) != 0 || len(desktop.ScheduledTasks) != 0 {
		t.Fatalf("child-owned desktop records survived: %#v", desktop)
	}
}

func TestLoadDerivesWorktreeTrustFromParent(t *testing.T) {
	root := t.TempDir()
	parentPath := filepath.Join(root, "repo")
	childPath := filepath.Join(parentPath, ".worktrees", "task-trust")
	if err := os.MkdirAll(childPath, 0o755); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(root, "state.json")
	catalog := NewCatalog(statePath)
	parent, err := catalog.Add(parentPath, "approve")
	if err != nil {
		t.Fatal(err)
	}
	child, err := catalog.AddWorktree(parent.ID, childPath, "pidesk/task-trust", "task_trust")
	if err != nil {
		t.Fatal(err)
	}

	body, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(body, &state); err != nil {
		t.Fatal(err)
	}
	workspaces, ok := state["workspaces"].([]any)
	if !ok {
		t.Fatal("workspaces is not a JSON array")
	}
	for _, raw := range workspaces {
		record, ok := raw.(map[string]any)
		if !ok || record["id"] != child.ID {
			continue
		}
		record["trust"] = "deny"
	}
	body, err = json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, body, 0o600); err != nil {
		t.Fatal(err)
	}

	reloaded := NewCatalog(statePath)
	child, err = reloaded.ResolveID(child.ID)
	if err != nil {
		t.Fatal(err)
	}
	if child.Trust != "approve" {
		t.Fatalf("stale child trust was not derived from parent: %#v", child)
	}
}
