package scheduler

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"pi-desk/internal/schedule"
	"pi-desk/internal/storage/sqlite"
	"pi-desk/internal/task"
)

func TestTickCapsConcurrentRunsAndQueuesTheRest(t *testing.T) {
	fixture := newFixture(t, 1)
	now := time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)
	fixture.scheduler.now = func() time.Time { return now }
	createDueSchedule(t, fixture, "one", now)
	createDueSchedule(t, fixture, "two", now)

	runs, err := fixture.scheduler.Tick(context.Background(), now, false)
	if err != nil {
		t.Fatal(err)
	}
	if runs != 2 {
		t.Fatalf("due count = %d, want 2", runs)
	}
	first := waitForCall(t, fixture.runner.calls)
	if first == "" {
		t.Fatal("first run did not start")
	}
	select {
	case second := <-fixture.runner.calls:
		t.Fatalf("second run started before the first released: %s", second)
	case <-time.After(40 * time.Millisecond):
	}
	close(fixture.runner.release)
	second := waitForCall(t, fixture.runner.calls)
	if second == first {
		t.Fatalf("second run reused first id %s", first)
	}
	fixture.scheduler.Wait()
}

func TestTickDisablesOnceAndAdvancesRecurring(t *testing.T) {
	fixture := newFixture(t, 3)
	now := time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)
	fixture.scheduler.now = func() time.Time { return now }

	once, err := fixture.schedules.Create(context.Background(), schedule.CreateInput{
		TaskID: createTask(t, fixture, "once"), Name: "once", Prompt: "run",
		WorkspaceID: "workspace-1", Frequency: schedule.FrequencyOnce,
		RunAt: timePointer(now.Add(-time.Minute)), NextRunAt: timePointer(now.Add(-time.Minute)),
		Timezone: "UTC", Enabled: true, CatchUp: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	recurring, err := fixture.schedules.Create(context.Background(), schedule.CreateInput{
		TaskID: createTask(t, fixture, "recurring"), Name: "recurring", Prompt: "run",
		WorkspaceID: "workspace-1", Frequency: schedule.FrequencyDaily, Time: "11:00",
		NextRunAt: timePointer(now.Add(-time.Minute)), Timezone: "UTC", Enabled: true, CatchUp: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.scheduler.Tick(context.Background(), now, false); err != nil {
		t.Fatal(err)
	}
	close(fixture.runner.release)
	fixture.scheduler.Wait()

	loadedOnce, err := fixture.schedules.Get(context.Background(), once.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loadedOnce.Enabled || loadedOnce.NextRunAt != nil {
		t.Fatalf("once schedule is still enabled: %#v", loadedOnce)
	}
	loadedRecurring, err := fixture.schedules.Get(context.Background(), recurring.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !loadedRecurring.Enabled || loadedRecurring.NextRunAt == nil || loadedRecurring.NextRunAt.Before(now) {
		t.Fatalf("recurring schedule did not advance: %#v", loadedRecurring)
	}

	// The same due row must not fire twice on the next tick.
	secondTick, err := fixture.scheduler.Tick(context.Background(), now, false)
	if err != nil {
		t.Fatal(err)
	}
	if secondTick != 0 {
		t.Fatalf("second tick due count = %d, want 0", secondTick)
	}
}

func TestTickMarksStartupCatchUpAndFailure(t *testing.T) {
	fixture := newFixture(t, 3)
	fixture.runner.err = errors.New("prompt failed")
	now := time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)
	fixture.scheduler.now = func() time.Time { return now }
	value, err := fixture.schedules.Create(context.Background(), schedule.CreateInput{
		TaskID: createTask(t, fixture, "broken"), Name: "broken", Prompt: "run",
		WorkspaceID: "workspace-1", Frequency: schedule.FrequencyDaily, Time: "11:00",
		NextRunAt: timePointer(now.Add(-2 * time.Hour)), Timezone: "UTC", Enabled: true, CatchUp: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.scheduler.Tick(context.Background(), now, true); err != nil {
		t.Fatal(err)
	}
	close(fixture.runner.release)
	fixture.scheduler.Wait()
	loaded, err := fixture.schedules.Get(context.Background(), value.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.LastStatus != schedule.StatusFailed || loaded.LastError != "prompt failed" || loaded.LastCatchUpAt == nil {
		t.Fatalf("failed catch-up was not recorded: %#v", loaded)
	}
}

type fixture struct {
	scheduler *Scheduler
	schedules *schedule.Service
	tasks     *task.Service
	runner    *blockingRunner
}

func newFixture(t *testing.T, maxConcurrent int) *fixture {
	t.Helper()
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	tasks := task.NewService(store)
	schedules := schedule.NewService(store)
	runner := &blockingRunner{calls: make(chan string, 16), release: make(chan struct{}), err: nil}
	scheduler := New(schedules, runner, Options{
		MaxConcurrent: maxConcurrent,
		CatchUpJitter: func() time.Duration { return 0 },
		Logf:          t.Logf,
	})
	return &fixture{scheduler: scheduler, schedules: schedules, tasks: tasks, runner: runner}
}

func createDueSchedule(t *testing.T, fixture *fixture, name string, now time.Time) schedule.Schedule {
	t.Helper()
	value, err := fixture.schedules.Create(context.Background(), schedule.CreateInput{
		TaskID: createTask(t, fixture, name), Name: name, Prompt: "run",
		WorkspaceID: "workspace-1", Frequency: schedule.FrequencyDaily, Time: "11:00",
		NextRunAt: timePointer(now.Add(-time.Minute)), Timezone: "UTC", Enabled: true, CatchUp: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func createTask(t *testing.T, fixture *fixture, name string) string {
	t.Helper()
	value, err := fixture.tasks.CreateTask(context.Background(), task.CreateTaskInput{
		Title: name, WorkspaceID: "workspace-1", Origin: task.OriginScheduled,
	})
	if err != nil {
		t.Fatal(err)
	}
	return value.ID
}

type blockingRunner struct {
	calls   chan string
	release chan struct{}
	err     error
}

func (runner *blockingRunner) RunScheduled(_ context.Context, value schedule.Schedule) (RunResult, error) {
	runner.calls <- value.ID
	<-runner.release
	if runner.err != nil {
		return RunResult{}, runner.err
	}
	return RunResult{ThreadID: "thread-" + value.ID, RunID: "run-" + value.ID}, nil
}

func waitForCall(t *testing.T, calls <-chan string) string {
	t.Helper()
	select {
	case value := <-calls:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for scheduled run")
		return ""
	}
}
