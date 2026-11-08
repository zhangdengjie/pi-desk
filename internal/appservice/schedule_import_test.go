package appservice

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"pi-desk/internal/schedule"
	"pi-desk/internal/storage/sqlite"
	"pi-desk/internal/task"
	"pi-desk/internal/workspace"
)

func TestImportLegacySchedulesIsIdempotent(t *testing.T) {
	root := t.TempDir()
	workspacePath := filepath.Join(root, "project")
	if err := os.MkdirAll(workspacePath, 0o755); err != nil {
		t.Fatal(err)
	}
	catalog := workspace.NewCatalog(filepath.Join(root, "state.json"))
	record, err := catalog.Add(workspacePath, "approve")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	next := now.Add(time.Hour).Format(time.RFC3339)
	if err := catalog.SaveDesktop(workspace.DesktopRecord{
		ScheduledTasks: []workspace.ScheduledTaskRecord{{
			ID: "schedule-legacy", Name: "Nightly", Prompt: "run tests",
			WorkspaceID: record.ID, Frequency: "daily", Time: "09:00",
			Enabled: true, NextRunAt: next, CreatedAt: now.Format(time.RFC3339), UpdatedAt: now.Format(time.RFC3339),
		}},
	}); err != nil {
		t.Fatal(err)
	}

	store, err := sqlite.Open(filepath.Join(root, "pi-desk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	tasks := task.NewService(store)
	schedules := schedule.NewService(store)
	created, skipped, err := importLegacySchedules(context.Background(), schedules, tasks, catalog)
	if err != nil {
		t.Fatal(err)
	}
	if created != 1 || skipped != 0 {
		t.Fatalf("first import = created %d, skipped %d", created, skipped)
	}
	imported, err := schedules.Get(context.Background(), "schedule-legacy")
	if err != nil {
		t.Fatal(err)
	}
	taskValue, err := tasks.GetTask(context.Background(), imported.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if taskValue.Title != "Nightly" || taskValue.Description != "run tests" || taskValue.WorkspaceID != record.ID || taskValue.Origin != task.OriginScheduled {
		t.Fatalf("unexpected imported task: %#v", taskValue)
	}
	if imported.NextRunAt == nil || imported.Frequency != schedule.FrequencyDaily || !imported.Enabled {
		t.Fatalf("unexpected imported schedule: %#v", imported)
	}

	created, skipped, err = importLegacySchedules(context.Background(), schedules, tasks, catalog)
	if err != nil {
		t.Fatal(err)
	}
	if created != 0 || skipped != 1 {
		t.Fatalf("second import = created %d, skipped %d", created, skipped)
	}
}

func TestImportLegacyScheduleReusesThreadTask(t *testing.T) {
	root := t.TempDir()
	workspacePath := filepath.Join(root, "project")
	if err := os.MkdirAll(workspacePath, 0o755); err != nil {
		t.Fatal(err)
	}
	catalog := workspace.NewCatalog(filepath.Join(root, "state.json"))
	record, err := catalog.Add(workspacePath, "approve")
	if err != nil {
		t.Fatal(err)
	}
	store, err := sqlite.Open(filepath.Join(root, "pi-desk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	tasks := task.NewService(store)
	existing, err := tasks.CreateTask(context.Background(), task.CreateTaskInput{
		Title: "Existing", Description: "existing", WorkspaceID: record.ID,
		Origin: task.OriginLegacy, LegacyThreadID: "thread-existing",
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := catalog.SaveDesktop(workspace.DesktopRecord{
		ScheduledTasks: []workspace.ScheduledTaskRecord{{
			ID: "schedule-thread", Name: "Thread", Prompt: "run", WorkspaceID: record.ID,
			Frequency: "once", RunAt: now.Add(time.Hour).Format(time.RFC3339), Enabled: false,
			LastThreadID: "thread-existing", CreatedAt: now.Format(time.RFC3339), UpdatedAt: now.Format(time.RFC3339),
		}},
	}); err != nil {
		t.Fatal(err)
	}
	schedules := schedule.NewService(store)
	created, _, err := importLegacySchedules(context.Background(), schedules, tasks, catalog)
	if err != nil {
		t.Fatal(err)
	}
	if created != 1 {
		t.Fatalf("created = %d", created)
	}
	imported, err := schedules.Get(context.Background(), "schedule-thread")
	if err != nil {
		t.Fatal(err)
	}
	if imported.TaskID != existing.ID {
		t.Fatalf("schedule task = %q, want %q", imported.TaskID, existing.ID)
	}
}
