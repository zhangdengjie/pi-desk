package appservice

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"pi-desk/internal/domain"
	"pi-desk/internal/sessionindex"
	"pi-desk/internal/storage/sqlite"
	"pi-desk/internal/task"
	"pi-desk/internal/workspace"
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

func TestTaskServiceAdoptsThreadManually(t *testing.T) {
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()
	workspaceService := task.NewService(store)
	service := &TaskService{
		service: workspaceService, store: store,
		threads: fakeThreads{desktop: workspace.DesktopRecord{Threads: []workspace.ThreadRecord{{
			ID: "thread-adopt", Title: "Adopt me", WorkspaceID: "ws-1", WorkspacePath: "/repo",
			Trust: "approve", Status: "idle", SessionPath: "/tmp/adopt.jsonl",
		}}}},
	}
	detail, err := service.AdoptThread(domain.AdoptThreadRequest{ThreadID: "thread-adopt"})
	if err != nil {
		t.Fatalf("adopt thread: %v", err)
	}
	if detail.ID == "" || detail.LegacyThreadID != "thread-adopt" || detail.Origin != string(task.OriginLegacy) {
		t.Fatalf("adopted detail = %+v", detail)
	}
	if len(detail.Runs) != 1 || detail.Runs[0].SessionPath != "/tmp/adopt.jsonl" || detail.Runs[0].Status != string(task.StatusCompleted) {
		t.Fatalf("adopted runs = %+v", detail.Runs)
	}
	if _, err := workspaceService.SetArchived(context.Background(), detail.ID, true); err != nil {
		t.Fatalf("archive adopted task: %v", err)
	}
	again, err := service.AdoptThread(domain.AdoptThreadRequest{ThreadID: "thread-adopt"})
	if err != nil || again.ID != detail.ID || again.ArchivedAt != 0 {
		t.Fatalf("adopt should be idempotent and unarchive: %+v, %v", again, err)
	}
	active, err := service.ListTasks()
	if err != nil || len(active) != 1 {
		t.Fatalf("active tasks = %+v, %v", active, err)
	}
	if _, err := service.AdoptThread(domain.AdoptThreadRequest{ThreadID: "missing"}); err == nil {
		t.Fatal("adopting an unknown thread should fail")
	}
}

func TestTaskServiceDisabled(t *testing.T) {
	service := NewTaskService(nil, nil, nil, nil, nil)
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

type fakeTaskAgent struct {
	aborted []domain.ThreadRequest
	started []domain.StartSessionRequest
	prompts []domain.PromptRequest
}

func (agent *fakeTaskAgent) Abort(request domain.ThreadRequest) (domain.CommandResult, error) {
	agent.aborted = append(agent.aborted, request)
	return domain.CommandResult{}, nil
}

func (agent *fakeTaskAgent) StartSession(request domain.StartSessionRequest) (domain.LiveSession, error) {
	agent.started = append(agent.started, request)
	return domain.LiveSession{ThreadID: request.ThreadID, Generation: 1}, nil
}

func (agent *fakeTaskAgent) SendPrompt(request domain.PromptRequest) (domain.CommandResult, error) {
	agent.prompts = append(agent.prompts, request)
	return domain.CommandResult{}, nil
}

type fakeMessages struct {
	messages []json.RawMessage
}

func (source fakeMessages) Messages(string) ([]json.RawMessage, error) {
	return source.messages, nil
}

type fakeImages map[string]sessionindex.ImageData

func (source fakeImages) Image(ref string) (sessionindex.ImageData, error) {
	value, ok := source[ref]
	if !ok {
		return sessionindex.ImageData{}, errors.New("missing image")
	}
	return value, nil
}

type fakeThreads struct {
	desktop workspace.DesktopRecord
}

func (source fakeThreads) Desktop() (workspace.DesktopRecord, error) {
	return source.desktop, nil
}

func TestTaskServiceCancelsActiveRun(t *testing.T) {
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()
	workspaceService := task.NewService(store)
	agent := &fakeTaskAgent{}
	service := &TaskService{service: workspaceService, store: store, agent: agent}
	ctx := context.Background()
	created, err := workspaceService.CreateTask(ctx, task.CreateTaskInput{
		Title: "Cancel me", Origin: task.OriginChat, LegacyThreadID: "thread-cancel",
	})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	run, err := workspaceService.CreateRun(ctx, created.ID, "pi")
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := workspaceService.StartRun(ctx, run.ID); err != nil {
		t.Fatalf("start run: %v", err)
	}

	detail, err := service.CancelTask(domain.TaskRequest{TaskID: created.ID})
	if err != nil {
		t.Fatalf("cancel task: %v", err)
	}
	if len(agent.aborted) != 1 || agent.aborted[0].ThreadID != "thread-cancel" {
		t.Fatalf("aborted = %+v", agent.aborted)
	}
	if detail.Status != string(task.StatusCancelled) || len(detail.Runs) != 1 || detail.Runs[0].Status != string(task.StatusCancelled) {
		t.Fatalf("detail = %+v", detail)
	}
}

func TestTaskServiceRetriesFailedRunFromLastUserPrompt(t *testing.T) {
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()
	workspaceService := task.NewService(store)
	agent := &fakeTaskAgent{}
	service := &TaskService{
		service: workspaceService, store: store, agent: agent,
		messages: fakeMessages{messages: []json.RawMessage{json.RawMessage(`{"role":"user","content":[{"type":"text","text":"retry me"}]}`)}},
		threads: fakeThreads{desktop: workspace.DesktopRecord{Threads: []workspace.ThreadRecord{{
			ID: "thread-retry", Title: "Retry", WorkspacePath: "/repo", Trust: "approve", SessionPath: "/tmp/retry.jsonl",
		}}}},
	}
	ctx := context.Background()
	created, err := workspaceService.CreateTask(ctx, task.CreateTaskInput{
		Title: "Retry me", Origin: task.OriginChat, LegacyThreadID: "thread-retry",
	})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	run, err := workspaceService.CreateRun(ctx, created.ID, "pi")
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := workspaceService.StartRun(ctx, run.ID); err != nil {
		t.Fatalf("start run: %v", err)
	}
	if _, err := workspaceService.FinishRun(ctx, run.ID, task.StatusFailed, "boom"); err != nil {
		t.Fatalf("finish run: %v", err)
	}
	detail, err := service.RetryTask(domain.TaskRequest{TaskID: created.ID})
	if err != nil {
		t.Fatalf("retry task: %v", err)
	}
	if len(agent.started) != 1 || agent.started[0].SessionPath != "/tmp/retry.jsonl" {
		t.Fatalf("started = %+v", agent.started)
	}
	if len(agent.prompts) != 1 || agent.prompts[0].Message != "retry me" {
		t.Fatalf("prompts = %+v", agent.prompts)
	}
	if detail.Status != string(task.StatusRunning) || len(detail.Runs) != 2 || detail.Runs[1].Status != string(task.StatusRunning) {
		t.Fatalf("detail = %+v", detail)
	}
}

func TestTaskServiceArchivesOnlyTerminalTasks(t *testing.T) {
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()
	workspaceService := task.NewService(store)
	service := &TaskService{service: workspaceService, store: store}
	ctx := context.Background()
	created, err := workspaceService.CreateTask(ctx, task.CreateTaskInput{Title: "Archive me"})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	run, err := workspaceService.CreateRun(ctx, created.ID, "pi")
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := workspaceService.StartRun(ctx, run.ID); err != nil {
		t.Fatalf("start run: %v", err)
	}
	if _, err := service.ArchiveTask(domain.TaskRequest{TaskID: created.ID}); err == nil {
		t.Fatal("active task should not be archivable")
	}
	if _, err := workspaceService.FinishRun(ctx, run.ID, task.StatusCompleted, ""); err != nil {
		t.Fatalf("finish run: %v", err)
	}
	archived, err := service.ArchiveTask(domain.TaskRequest{TaskID: created.ID})
	if err != nil {
		t.Fatalf("archive task: %v", err)
	}
	if archived.ArchivedAt == 0 {
		t.Fatalf("archive detail = %+v", archived)
	}
	active, err := service.ListTasks()
	if err != nil || len(active) != 0 {
		t.Fatalf("active tasks = %+v, %v", active, err)
	}
	hidden, err := service.ListArchivedTasks()
	if err != nil || len(hidden) != 1 || hidden[0].ID != created.ID {
		t.Fatalf("archived tasks = %+v, %v", hidden, err)
	}
	restored, err := service.UnarchiveTask(domain.TaskRequest{TaskID: created.ID})
	if err != nil || restored.ArchivedAt != 0 {
		t.Fatalf("unarchive task = %+v, %v", restored, err)
	}
	active, err = service.ListTasks()
	if err != nil || len(active) != 1 {
		t.Fatalf("active after unarchive = %+v, %v", active, err)
	}
}

func TestTaskServiceRetriesLastUserImagesAndUnarchives(t *testing.T) {
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()
	workspaceService := task.NewService(store)
	agent := &fakeTaskAgent{}
	service := &TaskService{
		service: workspaceService, store: store, agent: agent,
		messages: fakeMessages{messages: []json.RawMessage{json.RawMessage(`{"role":"user","content":[{"type":"text","text":"look"},{"type":"image","mimeType":"image/png","bytes":5,"ref":"img-1"}]}`)}},
		images:   fakeImages{"img-1": {MIMEType: "image/png", Data: []byte("hello")}},
		threads: fakeThreads{desktop: workspace.DesktopRecord{Threads: []workspace.ThreadRecord{{
			ID: "thread-image", Title: "Image", WorkspacePath: "/repo", Trust: "approve", SessionPath: "/tmp/image.jsonl",
		}}}},
	}
	ctx := context.Background()
	created, err := workspaceService.CreateTask(ctx, task.CreateTaskInput{
		Title: "Image retry", Origin: task.OriginChat, LegacyThreadID: "thread-image",
	})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	run, err := workspaceService.CreateRun(ctx, created.ID, "pi")
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := workspaceService.StartRun(ctx, run.ID); err != nil {
		t.Fatalf("start run: %v", err)
	}
	if _, err := workspaceService.FinishRun(ctx, run.ID, task.StatusFailed, "boom"); err != nil {
		t.Fatalf("finish run: %v", err)
	}
	if _, err := workspaceService.SetArchived(ctx, created.ID, true); err != nil {
		t.Fatalf("archive task: %v", err)
	}
	detail, err := service.RetryTask(domain.TaskRequest{TaskID: created.ID})
	if err != nil {
		t.Fatalf("retry task: %v", err)
	}
	if detail.ArchivedAt != 0 {
		t.Fatalf("retry should unarchive, detail = %+v", detail)
	}
	if len(agent.prompts) != 1 || agent.prompts[0].Message != "look" {
		t.Fatalf("prompts = %+v", agent.prompts)
	}
	if len(agent.prompts[0].Images) != 1 {
		t.Fatalf("prompt images = %+v", agent.prompts[0].Images)
	}
	image := agent.prompts[0].Images[0]
	if image.Type != "image" || image.MIMEType != "image/png" || image.Data != "aGVsbG8=" {
		t.Fatalf("image = %+v", image)
	}
}

func TestTaskServiceFailsRetryWhenImageCannotBeRecovered(t *testing.T) {
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()
	workspaceService := task.NewService(store)
	agent := &fakeTaskAgent{}
	service := &TaskService{
		service: workspaceService, store: store, agent: agent,
		messages: fakeMessages{messages: []json.RawMessage{json.RawMessage(`{"role":"user","content":[{"type":"image","ref":"missing"}]}`)}},
		images:   fakeImages{},
		threads: fakeThreads{desktop: workspace.DesktopRecord{Threads: []workspace.ThreadRecord{{
			ID: "thread-missing", Title: "Missing", WorkspacePath: "/repo", Trust: "approve", SessionPath: "/tmp/missing.jsonl",
		}}}},
	}
	ctx := context.Background()
	created, err := workspaceService.CreateTask(ctx, task.CreateTaskInput{
		Title: "Missing image", Origin: task.OriginChat, LegacyThreadID: "thread-missing",
	})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	run, err := workspaceService.CreateRun(ctx, created.ID, "pi")
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := workspaceService.StartRun(ctx, run.ID); err != nil {
		t.Fatalf("start run: %v", err)
	}
	if _, err := workspaceService.FinishRun(ctx, run.ID, task.StatusFailed, "boom"); err != nil {
		t.Fatalf("finish run: %v", err)
	}
	if _, err := workspaceService.SetArchived(ctx, created.ID, true); err != nil {
		t.Fatalf("archive task: %v", err)
	}
	if _, err := service.RetryTask(domain.TaskRequest{TaskID: created.ID}); err == nil {
		t.Fatal("retry with an unavailable image should fail")
	}
	if len(agent.prompts) != 0 {
		t.Fatalf("prompt should not be sent: %+v", agent.prompts)
	}
	loaded, err := workspaceService.GetTask(ctx, created.ID)
	if err != nil || loaded.Status != task.StatusFailed || loaded.ArchivedAt == nil {
		t.Fatalf("task should stay failed and archived: %+v, %v", loaded, err)
	}
}
