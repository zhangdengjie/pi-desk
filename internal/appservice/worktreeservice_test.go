package appservice

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"pi-desk/internal/domain"
	"pi-desk/internal/gitexec"
	"pi-desk/internal/workspace"
	"pi-desk/internal/worktree"
)

func TestWorktreeServiceCreateListAndRemove(t *testing.T) {
	t.Setenv(R2WorktreeEnv, "1")
	root := initWorktreeRepository(t)
	catalog := workspace.NewCatalog(filepath.Join(t.TempDir(), "state.json"))
	parent, err := catalog.Add(root, "approve")
	if err != nil {
		t.Fatal(err)
	}
	service := NewWorktreeService(worktree.New(nil), catalog, noWorktreeBootstrap)
	created, err := service.Create(domain.WorktreeCreateRequest{WorkspaceID: parent.ID, TaskID: "task_isolated"})
	if err != nil {
		t.Fatal(err)
	}
	if created.WorkspaceID == "" || created.Path == "" || created.Branch == "" {
		t.Fatalf("incomplete worktree summary: %#v", created)
	}
	child, err := catalog.ResolveID(created.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentWorkspaceID != parent.ID || child.Trust != "approve" || child.WorktreeTaskID != "task_isolated" {
		t.Fatalf("child workspace was not registered: %#v", child)
	}

	listed, err := service.List(domain.WorktreeListRequest{WorkspaceID: parent.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].WorkspaceID != child.ID || listed[0].TaskID != "task_isolated" {
		t.Fatalf("unexpected worktree list: %#v", listed)
	}

	removed, err := service.Remove(domain.WorktreeRequest{WorkspaceID: parent.ID, TaskID: "task_isolated"})
	if err != nil {
		t.Fatal(err)
	}
	if !removed.Removed || removed.Orphaned {
		t.Fatalf("unexpected remove result: %#v", removed)
	}
	if _, err := catalog.ResolveID(child.ID); err == nil {
		t.Fatal("child workspace survived worktree removal")
	}
	if _, err := os.Stat(created.Path); err == nil {
		t.Fatal("worktree directory survived removal")
	}
}

func TestWorktreeServiceDisabled(t *testing.T) {
	t.Setenv(R2WorktreeEnv, "0")
	catalog := workspace.NewCatalog(filepath.Join(t.TempDir(), "state.json"))
	service := NewWorktreeService(worktree.New(nil), catalog, noWorktreeBootstrap)
	if service.Enabled() {
		t.Fatal("worktree service should be disabled")
	}
	if _, err := service.Create(domain.WorktreeCreateRequest{WorkspaceID: "workspace-1", TaskID: "task"}); err == nil {
		t.Fatal("disabled Create should fail")
	}
	listed, err := service.List(domain.WorktreeListRequest{WorkspaceID: "workspace-1"})
	if err != nil || listed != nil {
		t.Fatalf("disabled List = %#v, %v", listed, err)
	}
}

func TestWorktreeServiceRejectsRemoteAndNonRepository(t *testing.T) {
	t.Setenv(R2WorktreeEnv, "1")
	root := t.TempDir()
	catalog := workspace.NewCatalog(filepath.Join(t.TempDir(), "state.json"))
	parent, err := catalog.Add(root, "approve")
	if err != nil {
		t.Fatal(err)
	}
	service := NewWorktreeService(worktree.New(nil), catalog, noWorktreeBootstrap)
	if _, err := service.Create(domain.WorktreeCreateRequest{WorkspaceID: parent.ID, TaskID: "task_not_repo"}); err == nil {
		t.Fatal("non-git workspace should fail")
	}
}

func noWorktreeBootstrap(string) worktree.Bootstrap {
	return worktree.Bootstrap{Mode: worktree.BootstrapNone}
}

func TestWorktreeServiceAppliesConfiguredBootstrap(t *testing.T) {
	t.Setenv(R2WorktreeEnv, "1")
	root := initWorktreeRepository(t)
	if err := os.WriteFile(filepath.Join(root, ".env.example"), []byte("SAFE=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	catalog := workspace.NewCatalog(filepath.Join(t.TempDir(), "state.json"))
	parent, err := catalog.Add(root, "approve")
	if err != nil {
		t.Fatal(err)
	}
	service := NewWorktreeService(worktree.New(nil), catalog, func(string) worktree.Bootstrap {
		return worktree.Bootstrap{Mode: worktree.BootstrapCopy, Copy: []string{".env.example"}}
	})
	created, err := service.Create(domain.WorktreeCreateRequest{WorkspaceID: parent.ID, TaskID: "task_bootstrap"})
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(created.Path, ".env.example"))
	if err != nil || string(body) != "SAFE=1\n" {
		t.Fatalf("bootstrap copy was not applied: %q, %v", body, err)
	}
}

func initWorktreeRepository(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	runWorktreeGit(t, root, "init", "-q")
	runWorktreeGit(t, root, "config", "user.email", "pi-desk@example.invalid")
	runWorktreeGit(t, root, "config", "user.name", "Pi Desk Test")
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runWorktreeGit(t, root, "add", ".")
	runWorktreeGit(t, root, "commit", "-qm", "initial")
	return root
}

func runWorktreeGit(t *testing.T, directory string, args ...string) {
	t.Helper()
	if _, err := (gitexec.Runner{}).Run(context.Background(), directory, args...); err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
}
