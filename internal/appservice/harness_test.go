package appservice_test

import (
	"context"
	"path/filepath"
	"testing"

	"pi-desk/internal/appservice"
	"pi-desk/internal/storage/sqlite"
	"pi-desk/internal/workspace"
)

func TestStartHarnessImportsLegacyThreads(t *testing.T) {
	t.Setenv(appservice.HarnessEnv, "1")
	directory := t.TempDir()
	catalog := workspace.NewCatalog(filepath.Join(directory, "state.json"))
	desktop := workspace.DesktopRecord{Threads: []workspace.ThreadRecord{{
		ID:            "thread_1",
		Title:         "Legacy Thread",
		WorkspacePath: "/tmp/legacy-workspace",
		SessionPath:   "/tmp/legacy-session.jsonl",
		Trust:         "approve",
		Status:        "idle",
	}}}
	if err := catalog.SaveDesktop(desktop); err != nil {
		t.Fatalf("save desktop: %v", err)
	}

	harness, err := appservice.StartHarness(context.Background(), directory, catalog)
	if err != nil {
		t.Fatalf("start harness: %v", err)
	}
	if harness == nil {
		t.Fatal("harness is nil")
	}
	harness.Close()

	store, err := sqlite.Open(filepath.Join(directory, "pi-desk.db"))
	if err != nil {
		t.Fatalf("reopen harness db: %v", err)
	}
	defer store.Close()
	tasks, err := store.ListTasks(context.Background(), 10)
	if err != nil {
		t.Fatalf("list tasks: %v", err)
	}
	if len(tasks) != 1 || tasks[0].LegacyThreadID != "thread_1" || tasks[0].Title != "Legacy Thread" {
		t.Fatalf("imported tasks = %+v", tasks)
	}
}

func TestStartHarnessDisabled(t *testing.T) {
	t.Setenv(appservice.HarnessEnv, "")
	directory := t.TempDir()
	harness, err := appservice.StartHarness(context.Background(), directory, workspace.NewCatalog(filepath.Join(directory, "state.json")))
	if err != nil {
		t.Fatalf("disabled harness should not error: %v", err)
	}
	if harness != nil {
		t.Fatal("disabled harness should be nil")
	}
}
