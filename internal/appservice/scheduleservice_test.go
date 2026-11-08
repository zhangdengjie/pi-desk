package appservice

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"pi-desk/internal/domain"
	"pi-desk/internal/schedule"
	"pi-desk/internal/scheduler"
	"pi-desk/internal/storage/sqlite"
	"pi-desk/internal/task"
)

func TestScheduleServiceCRUD(t *testing.T) {
	t.Setenv(R2SchedulerEnv, "1")
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	tasks := task.NewService(store)
	created, err := tasks.CreateTask(context.Background(), task.CreateTaskInput{
		Title: "Nightly", WorkspaceID: "workspace-1", Origin: task.OriginScheduled,
		LegacyThreadID: "thread-schedule",
	})
	if err != nil {
		t.Fatal(err)
	}
	service := NewScheduleService(schedule.NewService(store), tasks, nil)
	value, err := service.SaveSchedule(domain.ScheduleSaveRequest{
		TaskID: created.ID, Name: "Nightly", Prompt: "run tests", WorkspaceID: "workspace-1",
		Frequency: "daily", Time: "09:00", Timezone: "UTC", Enabled: true, CatchUp: true,
		LastThreadID: "thread-schedule",
	})
	if err != nil {
		t.Fatal(err)
	}
	if value.ID == "" || value.NextRunAt == "" || !value.Enabled {
		t.Fatalf("unexpected created schedule: %#v", value)
	}
	listed, err := service.ListSchedules()
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].ID != value.ID {
		t.Fatalf("list = %#v", listed)
	}

	value.Name = "Renamed"
	value.Enabled = false
	updated, err := service.SaveSchedule(domain.ScheduleSaveRequest{
		ID: value.ID, TaskID: created.ID, Name: value.Name, Prompt: value.Prompt,
		WorkspaceID: value.WorkspaceID, Frequency: value.Frequency, Time: value.Time,
		Timezone: value.Timezone, Enabled: false, CatchUp: true, LastThreadID: value.LastThreadID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "Renamed" || updated.Enabled || updated.NextRunAt != "" {
		t.Fatalf("update did not persist: %#v", updated)
	}
	if err := service.DeleteSchedule(domain.ScheduleIDRequest{ScheduleID: value.ID}); err != nil {
		t.Fatal(err)
	}
	listed, err = service.ListSchedules()
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 0 {
		t.Fatalf("schedule survived delete: %#v", listed)
	}
}

func TestScheduleServiceDisabled(t *testing.T) {
	t.Setenv(R2SchedulerEnv, "0")
	service := NewScheduleService(nil, nil, nil)
	if service.Enabled() {
		t.Fatal("schedule service should be disabled")
	}
	if _, err := service.ListSchedules(); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SaveSchedule(domain.ScheduleSaveRequest{}); err == nil {
		t.Fatal("disabled save should fail")
	}
}

type fakeScheduleRunner struct {
	result scheduler.RunResult
	err    error
	ran    []string
}

func (runner *fakeScheduleRunner) RunScheduled(_ context.Context, value schedule.Schedule) (scheduler.RunResult, error) {
	runner.ran = append(runner.ran, value.ID)
	return runner.result, runner.err
}

func TestScheduleServiceRunNowAndReconcile(t *testing.T) {
	t.Setenv(R2SchedulerEnv, "1")
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	tasks := task.NewService(store)
	created, err := tasks.CreateTask(context.Background(), task.CreateTaskInput{
		Title: "Nightly", WorkspaceID: "workspace-1", Origin: task.OriginScheduled,
		LegacyThreadID: "thread-schedule",
	})
	if err != nil {
		t.Fatal(err)
	}
	runner := &fakeScheduleRunner{result: scheduler.RunResult{ThreadID: "thread-schedule", RunID: "run-manual", SessionPath: "/tmp/session.jsonl"}}
	service := NewScheduleService(schedule.NewService(store), tasks, runner)
	value, err := service.SaveSchedule(domain.ScheduleSaveRequest{
		TaskID: created.ID, Name: "Nightly", Prompt: "run", WorkspaceID: "workspace-1",
		Frequency: "daily", Time: "09:00", Timezone: "UTC", Enabled: true, CatchUp: true,
		LastThreadID: "thread-schedule",
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.RunNow(domain.ScheduleIDRequest{ScheduleID: value.ID})
	if err != nil {
		t.Fatal(err)
	}
	if result.ThreadID != "thread-schedule" || result.RunID != "run-manual" || result.SessionPath != "/tmp/session.jsonl" || len(runner.ran) != 1 {
		t.Fatalf("unexpected manual run: %#v, ran=%v", result, runner.ran)
	}
	loaded, err := service.schedules.Get(context.Background(), value.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.LastStatus != schedule.StatusStarted || loaded.LastThreadID != "thread-schedule" {
		t.Fatalf("manual run did not mark started: %#v", loaded)
	}

	run, err := tasks.CreateRun(context.Background(), created.ID, "pi")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tasks.StartRun(context.Background(), run.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tasks.FinishRun(context.Background(), run.ID, task.StatusCompleted, ""); err != nil {
		t.Fatal(err)
	}
	listed, err := service.ListSchedules()
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].LastStatus != string(schedule.StatusCompleted) {
		t.Fatalf("schedule did not reconcile completion: %#v", listed)
	}
}

func TestScheduleSummaryFormatsTimes(t *testing.T) {
	at := time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)
	value := scheduleSummary(schedule.Schedule{
		ID: "schedule", TaskID: "task", Name: "n", Prompt: "p", WorkspaceID: "w",
		Frequency: schedule.FrequencyDaily, Time: "09:00", Timezone: "UTC",
		NextRunAt: &at, CreatedAt: at, UpdatedAt: at,
	})
	if value.NextRunAt != "2026-11-09T10:00:00Z" || value.CreatedAt != "2026-11-09T10:00:00Z" {
		t.Fatalf("unexpected time format: %#v", value)
	}
}
