package task_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"pi-desk/internal/storage/sqlite"
	"pi-desk/internal/task"
)

func newService(t *testing.T) (*task.Service, func()) {
	t.Helper()
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	return task.NewService(store), func() {
		if err := store.Close(); err != nil {
			t.Errorf("close store: %v", err)
		}
	}
}

func TestTaskRunLifecycle(t *testing.T) {
	service, closeStore := newService(t)
	defer closeStore()
	ctx := context.Background()

	created, err := service.CreateTask(ctx, task.CreateTaskInput{Title: "Lifecycle"})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if created.Status != task.StatusCreated {
		t.Fatalf("new task status = %s", created.Status)
	}
	run, err := service.CreateRun(ctx, created.ID, "pi")
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if run.Status != task.StatusQueued {
		t.Fatalf("new run status = %s", run.Status)
	}
	started, err := service.StartRun(ctx, run.ID)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	if started.Status != task.StatusRunning || started.StartedAt == nil {
		t.Fatalf("started run = %+v", started)
	}
	loadedTask, err := service.GetTask(ctx, created.ID)
	if err != nil || loadedTask.Status != task.StatusRunning {
		t.Fatalf("task after run start = %+v, %v", loadedTask, err)
	}
	finished, err := service.FinishRun(ctx, run.ID, task.StatusCompleted, "")
	if err != nil {
		t.Fatalf("finish run: %v", err)
	}
	if finished.Status != task.StatusCompleted || finished.FinishedAt == nil {
		t.Fatalf("finished run = %+v", finished)
	}
	if _, err := service.FinishRun(ctx, run.ID, task.StatusCompleted, ""); !errors.Is(err, task.ErrInvalidTransition) {
		t.Fatalf("second finish should be invalid, got %v", err)
	}
	if _, err := service.CreateRun(ctx, created.ID, "pi"); err != nil {
		t.Fatalf("task should still allow another run: %v", err)
	}
}

func TestStartRunForThreadReusesActiveRun(t *testing.T) {
	service, closeStore := newService(t)
	defer closeStore()
	ctx := context.Background()

	firstTask, firstRun, err := service.StartRunForThread(ctx, "thread_1", "Thread One", "pi")
	if err != nil {
		t.Fatalf("start first run: %v", err)
	}
	secondTask, secondRun, err := service.StartRunForThread(ctx, "thread_1", "Thread One", "pi")
	if err != nil {
		t.Fatalf("start second run: %v", err)
	}
	if firstTask.ID != secondTask.ID || firstRun.ID != secondRun.ID {
		t.Fatalf("active run was not reused: %s/%s vs %s/%s", firstTask.ID, firstRun.ID, secondTask.ID, secondRun.ID)
	}
	if _, err := service.FinishRun(ctx, firstRun.ID, task.StatusCompleted, ""); err != nil {
		t.Fatalf("finish run: %v", err)
	}
	_, thirdRun, err := service.StartRunForThread(ctx, "thread_1", "Thread One", "pi")
	if err != nil {
		t.Fatalf("start third run: %v", err)
	}
	if thirdRun.ID == firstRun.ID {
		t.Fatalf("completed run should not be reused")
	}
}

type fakeLegacySource struct {
	threads []task.LegacyThread
}

func (source fakeLegacySource) LegacyThreads() ([]task.LegacyThread, error) {
	return source.threads, nil
}

func TestImportLegacyIdempotentAndDryRun(t *testing.T) {
	service, closeStore := newService(t)
	defer closeStore()
	ctx := context.Background()
	source := fakeLegacySource{threads: []task.LegacyThread{
		{ID: "thread_a", Title: "A", WorkspaceID: "ws_1", SessionPath: "/tmp/a.jsonl"},
		{ID: "thread_b", Title: "", WorkspaceID: "ws_1"},
	}}

	dryRun, err := task.ImportLegacy(ctx, service, source, true)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if dryRun.Created != 2 || dryRun.Skipped != 0 {
		t.Fatalf("dry run report = %+v", dryRun)
	}
	tasks, err := service.ListTasks(ctx, 10)
	if err != nil || len(tasks) != 0 {
		t.Fatalf("dry run wrote tasks: %+v, %v", tasks, err)
	}

	first, err := task.ImportLegacy(ctx, service, source, false)
	if err != nil {
		t.Fatalf("first import: %v", err)
	}
	if first.Created != 2 || first.Skipped != 0 || first.Runs != 1 {
		t.Fatalf("first import report = %+v", first)
	}
	second, err := task.ImportLegacy(ctx, service, source, false)
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if second.Created != 0 || second.Skipped != 2 || second.Runs != 0 {
		t.Fatalf("second import report = %+v", second)
	}
	found, err := service.FindTaskByLegacyThreadID(ctx, "thread_a")
	if err != nil {
		t.Fatalf("find imported task: %v", err)
	}
	if found.Title != "A" || found.Origin != task.OriginLegacy {
		t.Fatalf("imported task = %+v", found)
	}
	runs, err := service.ListRuns(ctx, found.ID)
	if err != nil || len(runs) != 1 || runs[0].SessionPath != "/tmp/a.jsonl" {
		t.Fatalf("imported runs = %+v, %v", runs, err)
	}
	fallback, err := service.FindTaskByLegacyThreadID(ctx, "thread_b")
	if err != nil || fallback.Title != "thread_b" {
		t.Fatalf("fallback title = %+v, %v", fallback, err)
	}
}

func TestTaskArchiveVisibility(t *testing.T) {
	service, closeStore := newService(t)
	defer closeStore()
	ctx := context.Background()

	created, err := service.CreateTask(ctx, task.CreateTaskInput{Title: "Archivable"})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	run, err := service.CreateRun(ctx, created.ID, "pi")
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := service.StartRun(ctx, run.ID); err != nil {
		t.Fatalf("start run: %v", err)
	}
	if _, err := service.SetArchived(ctx, created.ID, true); !errors.Is(err, task.ErrInvalidTransition) {
		t.Fatalf("active task archive should be invalid, got %v", err)
	}
	if _, err := service.FinishRun(ctx, run.ID, task.StatusCompleted, ""); err != nil {
		t.Fatalf("finish run: %v", err)
	}
	archived, err := service.SetArchived(ctx, created.ID, true)
	if err != nil {
		t.Fatalf("archive task: %v", err)
	}
	if archived.ArchivedAt == nil {
		t.Fatalf("archived task = %+v", archived)
	}
	active, err := service.ListTasks(ctx, 10)
	if err != nil || len(active) != 0 {
		t.Fatalf("active tasks = %+v, %v", active, err)
	}
	hidden, err := service.ListArchivedTasks(ctx, 10)
	if err != nil || len(hidden) != 1 || hidden[0].ID != created.ID {
		t.Fatalf("archived tasks = %+v, %v", hidden, err)
	}
	restored, err := service.SetArchived(ctx, created.ID, false)
	if err != nil || restored.ArchivedAt != nil {
		t.Fatalf("unarchive task = %+v, %v", restored, err)
	}
	active, err = service.ListTasks(ctx, 10)
	if err != nil || len(active) != 1 {
		t.Fatalf("active after unarchive = %+v, %v", active, err)
	}
}

func TestReconcileInterruptedRuns(t *testing.T) {
	service, closeStore := newService(t)
	defer closeStore()
	ctx := context.Background()

	taskValue, err := service.CreateTask(ctx, task.CreateTaskInput{Title: "Interrupted"})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	run, err := service.CreateRun(ctx, taskValue.ID, "pi")
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := service.StartRun(ctx, run.ID); err != nil {
		t.Fatalf("start run: %v", err)
	}
	repaired, err := service.ReconcileInterruptedRuns(ctx, "interrupted before restart")
	if err != nil || repaired != 1 {
		t.Fatalf("reconcile = %d, %v", repaired, err)
	}
	loadedRun, err := service.GetRun(ctx, run.ID)
	if err != nil || loadedRun.Status != task.StatusFailed || loadedRun.Error != "interrupted before restart" {
		t.Fatalf("run = %+v, %v", loadedRun, err)
	}
	loadedTask, err := service.GetTask(ctx, taskValue.ID)
	if err != nil || loadedTask.Status != task.StatusFailed {
		t.Fatalf("task = %+v, %v", loadedTask, err)
	}
	repaired, err = service.ReconcileInterruptedRuns(ctx, "again")
	if err != nil || repaired != 0 {
		t.Fatalf("second reconcile = %d, %v", repaired, err)
	}
}

func TestStateMachineRejectsTerminalTransitions(t *testing.T) {
	if !task.CanTransitionTask(task.StatusCreated, task.StatusRunning) {
		t.Fatal("created -> running should be allowed")
	}
	if task.CanTransitionTask(task.StatusCompleted, task.StatusRunning) {
		t.Fatal("completed -> running must be rejected")
	}
	if !task.CanTransitionRun(task.StatusQueued, task.StatusRunning) {
		t.Fatal("queued -> running should be allowed")
	}
	if task.CanTransitionRun(task.StatusFailed, task.StatusRunning) {
		t.Fatal("failed -> running must be rejected")
	}
}
