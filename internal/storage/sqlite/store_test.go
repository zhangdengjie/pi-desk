package sqlite_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"pi-desk/internal/storage/sqlite"
	"pi-desk/internal/task"
)

func openTestStore(t *testing.T) *sqlite.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pi-desk.db")
	store, err := sqlite.Open(path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close store: %v", err)
		}
	})
	return store
}

func createRunFixture(t *testing.T, store *sqlite.Store) (task.Task, task.Run) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	value := task.Task{
		ID: "task_1", Title: "Fixture", Status: task.StatusRunning,
		Origin: task.OriginChat, Metadata: "{}", CreatedAt: now, UpdatedAt: now,
	}
	if err := store.CreateTask(context.Background(), value); err != nil {
		t.Fatalf("create task: %v", err)
	}
	run := task.Run{
		ID: "run_1", TaskID: value.ID, Runtime: "pi", Status: task.StatusRunning,
		Attempt: 1, CreatedAt: now,
	}
	if err := store.CreateRun(context.Background(), run); err != nil {
		t.Fatalf("create run: %v", err)
	}
	return value, run
}

func TestStoreCRUDAndMigration(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	taskValue, run := createRunFixture(t, store)

	loadedTask, err := store.GetTask(ctx, taskValue.ID)
	if err != nil {
		t.Fatalf("get task: %v", err)
	}
	if loadedTask.Title != taskValue.Title || loadedTask.Origin != task.OriginChat {
		t.Fatalf("unexpected task: %+v", loadedTask)
	}
	if _, err := store.FindTaskByLegacyThreadID(ctx, ""); !errors.Is(err, task.ErrNotFound) {
		t.Fatalf("empty thread lookup should be not found, got %v", err)
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	if err := store.UpdateTaskStatus(ctx, taskValue.ID, task.StatusCompleted, now, &now); err != nil {
		t.Fatalf("update task: %v", err)
	}
	completed, err := store.GetTask(ctx, taskValue.ID)
	if err != nil {
		t.Fatalf("get completed task: %v", err)
	}
	if completed.Status != task.StatusCompleted || completed.CompletedAt == nil {
		t.Fatalf("task not completed: %+v", completed)
	}

	event := task.Event{
		ID: "evt_1", RunID: run.ID, Seq: 1, Type: "run.started",
		Payload: []byte(`{"ok":true}`), PayloadBytes: 11, CreatedAt: now,
	}
	if err := store.AppendEvent(ctx, event); err != nil {
		t.Fatalf("append event: %v", err)
	}
	if err := store.AppendEvent(ctx, event); err != nil {
		t.Fatalf("duplicate append should be idempotent: %v", err)
	}
	count, err := store.CountEvents(ctx, run.ID)
	if err != nil || count != 1 {
		t.Fatalf("count events = %d, %v", count, err)
	}
	seq, err := store.MaxEventSeq(ctx, run.ID)
	if err != nil || seq != 1 {
		t.Fatalf("max seq = %d, %v", seq, err)
	}
	events, err := store.ListEvents(ctx, run.ID, 0)
	if err != nil || len(events) != 1 || string(events[0].Payload) != `{"ok":true}` {
		t.Fatalf("events = %+v, %v", events, err)
	}

	usage := task.Usage{
		ID: "usage_1", RunID: run.ID, Provider: "openai", Model: "gpt",
		InputTokens: 10, OutputTokens: 5, CacheReadTokens: 2, CacheWriteTokens: 1,
		CreatedAt: now,
	}
	if err := store.UpsertUsage(ctx, usage); err != nil {
		t.Fatalf("upsert usage: %v", err)
	}
	usage.InputTokens = 20
	if err := store.UpsertUsage(ctx, usage); err != nil {
		t.Fatalf("update usage: %v", err)
	}
	loadedUsage, err := store.GetUsage(ctx, run.ID)
	if err != nil || loadedUsage.InputTokens != 20 {
		t.Fatalf("usage = %+v, %v", loadedUsage, err)
	}
}

func TestOpenPathWithSpacesAndReopen(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "with space")
	path := filepath.Join(dir, "pi desk.db")
	store, err := sqlite.Open(path)
	if err != nil {
		t.Fatalf("open path with spaces: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat db: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("db mode = %o, want 600", info.Mode().Perm())
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if err := store.CreateTask(context.Background(), task.Task{
		ID: "task_space", Title: "Space", Status: task.StatusCreated,
		Origin: task.OriginChat, Metadata: "{}", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	reopened, err := sqlite.Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer reopened.Close()
	if _, err := reopened.GetTask(context.Background(), "task_space"); err != nil {
		t.Fatalf("task after reopen: %v", err)
	}
}

func TestConcurrentWritesUseSingleWriter(t *testing.T) {
	store := openTestStore(t)
	_, run := createRunFixture(t, store)
	ctx := context.Background()
	const goroutines = 8
	const perGoroutine = 25
	var wait sync.WaitGroup
	errs := make(chan error, goroutines*perGoroutine)
	for worker := 0; worker < goroutines; worker++ {
		for index := 0; index < perGoroutine; index++ {
			wait.Add(1)
			go func(worker, index int) {
				defer wait.Done()
				seq := uint64(worker*perGoroutine + index + 1)
				err := store.AppendEvent(ctx, task.Event{
					ID: fmt.Sprintf("evt_%d_%d", worker, index), RunID: run.ID, Seq: seq,
					Type: "tool.updated", Payload: []byte(`{}`), CreatedAt: time.Now().UTC(),
				})
				if err != nil {
					errs <- err
				}
			}(worker, index)
		}
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("append event: %v", err)
	}
	count, err := store.CountEvents(ctx, run.ID)
	if err != nil {
		t.Fatalf("count events: %v", err)
	}
	if count != goroutines*perGoroutine {
		t.Fatalf("count = %d, want %d", count, goroutines*perGoroutine)
	}
}
