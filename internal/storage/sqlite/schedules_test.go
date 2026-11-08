package sqlite

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"pi-desk/internal/schedule"
	"pi-desk/internal/task"
)

func TestScheduleStoreRoundTripAndDueQuery(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()
	now := time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)
	created := task.Task{
		ID: "task-schedule", Title: "Nightly", Description: "run tests",
		Status: task.StatusCreated, WorkspaceID: "workspace-1", Origin: task.OriginScheduled,
		Metadata: "{}", CreatedAt: now, UpdatedAt: now,
	}
	if err := store.CreateTask(ctx, created); err != nil {
		t.Fatal(err)
	}
	next := now.Add(-time.Minute)
	last := now.Add(-2 * time.Hour)
	value := schedule.Schedule{
		ID: "schedule-1", TaskID: created.ID, Name: "Nightly", Prompt: "run tests",
		WorkspaceID: "workspace-1", ModelProvider: "openai", ModelID: "gpt-5",
		ModelName: "GPT-5", ThinkingLevel: "high", Frequency: schedule.FrequencyWeekly,
		Time: "09:30", Weekday: 1, Timezone: "UTC", Enabled: true, CatchUp: true,
		NextRunAt: &next, LastRunAt: &last, LastStatus: schedule.StatusCompleted,
		LastError: "boom", LastThreadID: "thread-1", CreatedAt: now, UpdatedAt: now,
	}
	if err := store.CreateSchedule(ctx, value); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.GetSchedule(ctx, value.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.TaskID != value.TaskID || loaded.Frequency != value.Frequency || loaded.Weekday != 1 ||
		loaded.ModelProvider != "openai" || loaded.ModelID != "gpt-5" || loaded.LastStatus != schedule.StatusCompleted ||
		loaded.LastError != "boom" || loaded.LastThreadID != "thread-1" || !loaded.Enabled || !loaded.CatchUp {
		t.Fatalf("round trip lost fields: %#v", loaded)
	}
	if loaded.NextRunAt == nil || !loaded.NextRunAt.Equal(next) || loaded.LastRunAt == nil || !loaded.LastRunAt.Equal(last) {
		t.Fatalf("round trip lost times: %#v", loaded)
	}

	future := now.Add(time.Hour)
	disabled := schedule.Schedule{
		ID: "schedule-2", TaskID: created.ID, Name: "Disabled", Prompt: "disabled",
		WorkspaceID: "workspace-1", Frequency: schedule.FrequencyDaily, Time: "09:00",
		Timezone: "UTC", Enabled: false, CatchUp: true, NextRunAt: &future,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := store.CreateSchedule(ctx, disabled); err != nil {
		t.Fatal(err)
	}
	due, err := store.ListDueSchedules(ctx, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 1 || due[0].ID != value.ID {
		t.Fatalf("due query returned %#v", due)
	}

	value.LastStatus = schedule.StatusStarted
	value.LastError = ""
	value.NextRunAt = &future
	value.UpdatedAt = now.Add(time.Minute)
	if err := store.UpdateSchedule(ctx, value); err != nil {
		t.Fatal(err)
	}
	loaded, err = store.GetSchedule(ctx, value.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.LastStatus != schedule.StatusStarted || loaded.LastError != "" || loaded.NextRunAt == nil || !loaded.NextRunAt.Equal(future) {
		t.Fatalf("update did not persist: %#v", loaded)
	}

	if err := store.DeleteSchedule(ctx, value.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetSchedule(ctx, value.ID); !errors.Is(err, schedule.ErrNotFound) {
		t.Fatalf("deleted schedule error = %v, want %v", err, schedule.ErrNotFound)
	}
	if err := store.DeleteSchedule(ctx, value.ID); !errors.Is(err, schedule.ErrNotFound) {
		t.Fatalf("second delete error = %v, want %v", err, schedule.ErrNotFound)
	}
}

func TestMigrationCreatesScheduleAndWorktreeTables(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for _, table := range []string{"task_schedules", "task_worktrees"} {
		var name string
		err := store.read.QueryRowContext(context.Background(),
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&name)
		if err != nil || name != table {
			t.Fatalf("table %s missing: name=%q err=%v", table, name, err)
		}
	}
}
