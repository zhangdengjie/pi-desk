package appservice

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"pi-desk/internal/domain"
	"pi-desk/internal/schedule"
	"pi-desk/internal/scheduler"
	"pi-desk/internal/storage/sqlite"
	"pi-desk/internal/task"
	"pi-desk/internal/workspace"
)

func TestScheduledRunnerStartsOneReusedSession(t *testing.T) {
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	tasks := task.NewService(store)
	created, err := tasks.CreateTask(context.Background(), task.CreateTaskInput{
		Title: "Nightly", WorkspaceID: "workspace-1", Origin: task.OriginScheduled,
		LegacyThreadID: "thread-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	catalog := fakeScheduledCatalog{path: "/tmp/project", trust: "approve"}
	threads := fakeThreads{desktop: workspace.DesktopRecord{Threads: []workspace.ThreadRecord{{
		ID: "thread-1", Title: "Nightly", WorkspaceID: "workspace-1",
		WorkspacePath: "/tmp/project", Trust: "approve", Status: "idle",
	}}}}
	agent := &fakeScheduledAgent{state: `{"sessionFile":"/tmp/project/session.jsonl"}`}
	runner := NewScheduledRunner(tasks, threads, catalog, agent)
	result, err := runner.RunScheduled(context.Background(), schedule.Schedule{
		TaskID: created.ID, Prompt: "run tests", ModelProvider: "openai", ModelID: "gpt-5", ThinkingLevel: "high",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ThreadID != "thread-1" || result.RunID == "" {
		t.Fatalf("unexpected result: %#v", result)
	}
	if len(agent.started) != 1 || agent.started[0].SessionPath != "" || agent.started[0].Workspace != "/tmp/project" {
		t.Fatalf("unexpected start: %#v", agent.started)
	}
	if len(agent.models) != 1 || agent.models[0].Provider != "openai" || agent.models[0].ModelID != "gpt-5" {
		t.Fatalf("unexpected model: %#v", agent.models)
	}
	if len(agent.thinking) != 1 || agent.thinking[0].Level != "high" {
		t.Fatalf("unexpected thinking: %#v", agent.thinking)
	}
	if len(agent.prompts) != 1 || agent.prompts[0].Message != "run tests" {
		t.Fatalf("unexpected prompt: %#v", agent.prompts)
	}
	runs, err := tasks.ListRuns(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].Status != task.StatusRunning || runs[0].SessionPath != "/tmp/project/session.jsonl" {
		t.Fatalf("unexpected run: %#v", runs)
	}
}

func TestScheduledRunnerRejectsActiveRunAndMissingThread(t *testing.T) {
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	tasks := task.NewService(store)
	created, err := tasks.CreateTask(context.Background(), task.CreateTaskInput{
		Title: "Busy", WorkspaceID: "workspace-1", Origin: task.OriginScheduled,
		LegacyThreadID: "thread-busy",
	})
	if err != nil {
		t.Fatal(err)
	}
	active, err := tasks.CreateRun(context.Background(), created.ID, "pi")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tasks.StartRun(context.Background(), active.ID); err != nil {
		t.Fatal(err)
	}
	threads := fakeThreads{desktop: workspace.DesktopRecord{Threads: []workspace.ThreadRecord{{
		ID: "thread-busy", Title: "Busy", WorkspaceID: "workspace-1",
		WorkspacePath: "/tmp/project", Trust: "approve", Status: "idle",
	}}}}
	runner := NewScheduledRunner(tasks, threads, fakeScheduledCatalog{path: "/tmp/project", trust: "approve"}, &fakeScheduledAgent{})
	if _, err := runner.RunScheduled(context.Background(), schedule.Schedule{TaskID: created.ID, Prompt: "run"}); !errors.Is(err, scheduler.ErrBusy) {
		t.Fatalf("active run error = %v, want %v", err, scheduler.ErrBusy)
	}

	missing, err := tasks.CreateTask(context.Background(), task.CreateTaskInput{
		Title: "No thread", WorkspaceID: "workspace-1", Origin: task.OriginScheduled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runner.RunScheduled(context.Background(), schedule.Schedule{TaskID: missing.ID, Prompt: "run"}); err == nil {
		t.Fatal("expected missing thread error")
	}
}

type fakeScheduledCatalog struct {
	path  string
	trust string
}

func (catalog fakeScheduledCatalog) ResolvePath(string) (workspace.Record, error) {
	return workspace.Record{
		ID: "workspace-1", Path: catalog.path,
		Location: workspace.Location{Kind: workspace.KindLocal, Local: workspace.LocalLocation{CanonicalPath: catalog.path}},
		Trust:    catalog.trust,
	}, nil
}

type fakeScheduledAgent struct {
	started   []domain.StartSessionRequest
	prompts   []domain.PromptRequest
	models    []domain.ModelRequest
	thinking  []domain.ThinkingRequest
	aborts    []domain.ThreadRequest
	state     string
	startErr  error
	promptErr error
}

func (agent *fakeScheduledAgent) StartSession(request domain.StartSessionRequest) (domain.LiveSession, error) {
	agent.started = append(agent.started, request)
	if agent.startErr != nil {
		return domain.LiveSession{}, agent.startErr
	}
	return domain.LiveSession{ThreadID: request.ThreadID, Generation: 1, StateJSON: agent.state}, nil
}

func (agent *fakeScheduledAgent) SendPrompt(request domain.PromptRequest) (domain.CommandResult, error) {
	agent.prompts = append(agent.prompts, request)
	return domain.CommandResult{}, agent.promptErr
}

func (agent *fakeScheduledAgent) SetModel(request domain.ModelRequest) (domain.CommandResult, error) {
	agent.models = append(agent.models, request)
	return domain.CommandResult{}, nil
}

func (agent *fakeScheduledAgent) SetThinkingLevel(request domain.ThinkingRequest) (domain.CommandResult, error) {
	agent.thinking = append(agent.thinking, request)
	return domain.CommandResult{}, nil
}

func (agent *fakeScheduledAgent) Abort(request domain.ThreadRequest) (domain.CommandResult, error) {
	agent.aborts = append(agent.aborts, request)
	return domain.CommandResult{}, nil
}
