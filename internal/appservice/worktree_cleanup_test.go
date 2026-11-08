package appservice

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"pi-desk/internal/domain"
	"pi-desk/internal/storage/sqlite"
	"pi-desk/internal/task"
	"pi-desk/internal/workspace"
	"pi-desk/internal/worktree"
)

func TestWorktreeServiceremoveForThread(t *testing.T) {
	t.Setenv(R2WorktreeEnv, "1")
	root := initWorktreeRepository(t)
	catalog := workspace.NewCatalog(filepath.Join(t.TempDir(), "state.json"))
	parent, err := catalog.Add(root, "approve")
	if err != nil {
		t.Fatal(err)
	}
	service := NewWorktreeService(worktree.New(nil), catalog, noWorktreeBootstrap)
	created, err := service.Create(domain.WorktreeCreateRequest{WorkspaceID: parent.ID, TaskID: "task_thread"})
	if err != nil {
		t.Fatal(err)
	}
	if err := catalog.SaveDesktop(workspace.DesktopRecord{Threads: []workspace.ThreadRecord{{
		ID: "thread-worktree", Title: "worktree task", WorkspaceID: created.WorkspaceID,
		WorkspacePath: created.Path, Trust: "approve", Status: "idle",
	}}}); err != nil {
		t.Fatal(err)
	}
	result, matched, err := service.removeForThread("thread-worktree")
	if err != nil {
		t.Fatal(err)
	}
	if !matched || !result.Removed || result.Orphaned {
		t.Fatalf("unexpected cleanup result: matched=%v result=%#v", matched, result)
	}
	if _, err := os.Stat(created.Path); err == nil {
		t.Fatal("worktree directory survived cleanup")
	}
	if _, err := catalog.ResolveID(created.WorkspaceID); err == nil {
		t.Fatal("child workspace survived cleanup")
	}
}

func TestArchiveTaskCleansWorktree(t *testing.T) {
	t.Setenv(R2WorktreeEnv, "1")
	root := initWorktreeRepository(t)
	statePath := filepath.Join(t.TempDir(), "state.json")
	catalog := workspace.NewCatalog(statePath)
	parent, err := catalog.Add(root, "approve")
	if err != nil {
		t.Fatal(err)
	}
	worktreeService := NewWorktreeService(worktree.New(nil), catalog, noWorktreeBootstrap)
	created, err := worktreeService.Create(domain.WorktreeCreateRequest{WorkspaceID: parent.ID, TaskID: "task_archive"})
	if err != nil {
		t.Fatal(err)
	}
	if err := catalog.SaveDesktop(workspace.DesktopRecord{Threads: []workspace.ThreadRecord{{
		ID: "thread-archive", Title: "archived", WorkspaceID: created.WorkspaceID,
		WorkspacePath: created.Path, Trust: "approve", Status: "idle",
	}}}); err != nil {
		t.Fatal(err)
	}
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	tasks := task.NewService(store)
	value, err := tasks.CreateTask(context.Background(), task.CreateTaskInput{
		Title: "archived", WorkspaceID: created.WorkspaceID,
		Origin: task.OriginScheduled, LegacyThreadID: "thread-archive",
	})
	if err != nil {
		t.Fatal(err)
	}
	service := &TaskService{service: tasks, store: store, threads: catalog, worktrees: worktreeService}
	detail, err := service.ArchiveTask(domain.TaskRequest{TaskID: value.ID})
	if err != nil {
		t.Fatal(err)
	}
	if detail.ArchivedAt == 0 {
		t.Fatalf("task was not archived: %#v", detail)
	}
	if _, err := os.Stat(created.Path); err == nil {
		t.Fatal("archiving did not clean the worktree")
	}
	if _, err := catalog.ResolveID(created.WorkspaceID); err == nil {
		t.Fatal("archiving did not remove the child workspace")
	}
}
