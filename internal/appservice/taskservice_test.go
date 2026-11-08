package appservice

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"pi-desk/internal/domain"
	"pi-desk/internal/storage/sqlite"
	"pi-desk/internal/task"
)

func TestTaskServiceReadModels(t *testing.T) {
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()
	workspace := task.NewService(store)
	service := &TaskService{service: workspace, store: store}
	ctx := context.Background()

	if !service.Enabled() {
		t.Fatal("service should be enabled with a store")
	}
	created, err := workspace.CreateTask(ctx, task.CreateTaskInput{Title: "Inspect me", Origin: task.OriginChat})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	run, err := workspace.CreateRun(ctx, created.ID, "pi")
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	run, err = workspace.StartRun(ctx, run.ID)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	now := time.Now().UTC()
	if err := store.AppendEvent(ctx, task.Event{
		ID: "evt_1", RunID: run.ID, Seq: 1, Type: "run.started",
		Payload: []byte(`{"ok":true}`), PayloadBytes: 11, CreatedAt: now,
	}); err != nil {
		t.Fatalf("append event: %v", err)
	}
	if err := store.UpsertUsage(ctx, task.Usage{
		ID: "usage_1", RunID: run.ID, Provider: "openai", Model: "gpt",
		InputTokens: 12, OutputTokens: 3, CacheReadTokens: 4, CacheWriteTokens: 1, CreatedAt: now,
	}); err != nil {
		t.Fatalf("upsert usage: %v", err)
	}

	tasks, err := service.ListTasks()
	if err != nil || len(tasks) != 1 || tasks[0].Title != "Inspect me" {
		t.Fatalf("tasks = %+v, %v", tasks, err)
	}
	detail, err := service.GetTask(domain.TaskRequest{TaskID: created.ID})
	if err != nil || detail.ID != created.ID || len(detail.Runs) != 1 {
		t.Fatalf("detail = %+v, %v", detail, err)
	}
	if detail.Runs[0].Usage == nil || detail.Runs[0].Usage.InputTokens != 12 {
		t.Fatalf("run usage = %+v", detail.Runs[0].Usage)
	}
	events, err := service.ListRunEvents(domain.TaskEventsRequest{RunID: run.ID, Limit: 10})
	if err != nil || len(events) != 1 || events[0].Type != "run.started" {
		t.Fatalf("events = %+v, %v", events, err)
	}
	usage, err := service.GetRunUsage(domain.TaskRunRequest{RunID: run.ID})
	if err != nil || usage.OutputTokens != 3 {
		t.Fatalf("usage = %+v, %v", usage, err)
	}
}

func TestTaskServiceDisabled(t *testing.T) {
	service := NewTaskService(nil)
	if service.Enabled() {
		t.Fatal("nil harness should be disabled")
	}
	tasks, err := service.ListTasks()
	if err != nil || len(tasks) != 0 {
		t.Fatalf("disabled list = %+v, %v", tasks, err)
	}
	if _, err := service.GetTask(domain.TaskRequest{TaskID: "task_1"}); err == nil {
		t.Fatal("disabled GetTask should fail")
	}
}
