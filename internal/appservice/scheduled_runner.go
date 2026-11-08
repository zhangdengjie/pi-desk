package appservice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"pi-desk/internal/domain"
	"pi-desk/internal/schedule"
	"pi-desk/internal/scheduler"
	"pi-desk/internal/task"
	"pi-desk/internal/workspace"
)

type scheduledAgent interface {
	StartSession(domain.StartSessionRequest) (domain.LiveSession, error)
	SendPrompt(domain.PromptRequest) (domain.CommandResult, error)
	SetModel(domain.ModelRequest) (domain.CommandResult, error)
	SetThinkingLevel(domain.ThinkingRequest) (domain.CommandResult, error)
	Abort(domain.ThreadRequest) (domain.CommandResult, error)
}

type scheduledThreadSource interface {
	Desktop() (workspace.DesktopRecord, error)
}

// ScheduledRunner turns a due schedule into one Pi turn. It deliberately
// reuses the Task's existing thread/session instead of creating a new thread on
// every firing: a Run is one execution, a Session can span several Runs.
type ScheduledRunner struct {
	tasks   *task.Service
	threads scheduledThreadSource
	catalog workspaceResolver
	agent   scheduledAgent
}

func NewScheduledRunner(tasks *task.Service, threads scheduledThreadSource, catalog workspaceResolver, agent scheduledAgent) *ScheduledRunner {
	return &ScheduledRunner{tasks: tasks, threads: threads, catalog: catalog, agent: agent}
}

func (runner *ScheduledRunner) RunScheduled(ctx context.Context, value schedule.Schedule) (scheduler.RunResult, error) {
	if runner == nil || runner.tasks == nil || runner.threads == nil || runner.catalog == nil || runner.agent == nil {
		return scheduler.RunResult{}, errors.New("scheduled runner is unavailable")
	}
	taskValue, err := runner.tasks.GetTask(ctx, value.TaskID)
	if err != nil {
		return scheduler.RunResult{}, fmt.Errorf("load scheduled task: %w", err)
	}
	runs, err := runner.tasks.ListRuns(ctx, taskValue.ID)
	if err != nil {
		return scheduler.RunResult{}, fmt.Errorf("list scheduled runs: %w", err)
	}
	for _, run := range runs {
		if run.Status == task.StatusQueued || run.Status == task.StatusRunning ||
			run.Status == task.StatusWaitingApproval || run.Status == task.StatusWaitingInput {
			return scheduler.RunResult{}, scheduler.ErrBusy
		}
	}
	threadID := strings.TrimSpace(taskValue.LegacyThreadID)
	if threadID == "" {
		threadID = strings.TrimSpace(value.LastThreadID)
	}
	if threadID == "" {
		return scheduler.RunResult{}, errors.New("scheduled task has no thread binding")
	}
	desktop, err := runner.threads.Desktop()
	if err != nil {
		return scheduler.RunResult{}, fmt.Errorf("load scheduled thread: %w", err)
	}
	var thread *workspace.ThreadRecord
	for index := range desktop.Threads {
		if desktop.Threads[index].ID == threadID {
			thread = &desktop.Threads[index]
			break
		}
	}
	if thread == nil {
		return scheduler.RunResult{}, fmt.Errorf("scheduled thread %s is not registered", threadID)
	}
	if strings.TrimSpace(thread.WorkspacePath) == "" {
		return scheduler.RunResult{}, errors.New("scheduled runs are not supported for remote workspaces yet")
	}
	record, err := runner.catalog.ResolvePath(thread.WorkspacePath)
	if err != nil {
		return scheduler.RunResult{}, fmt.Errorf("resolve scheduled workspace: %w", err)
	}
	if record.Location.Kind != workspace.KindLocal {
		return scheduler.RunResult{}, errors.New("scheduled runs require a local workspace")
	}
	if record.Trust != "approve" {
		return scheduler.RunResult{}, errors.New("scheduled workspace is not trusted")
	}
	if taskValue.Status == task.StatusFailed || taskValue.Status == task.StatusCancelled {
		if _, transitionErr := runner.tasks.TransitionTask(ctx, taskValue.ID, task.StatusQueued); transitionErr != nil {
			return scheduler.RunResult{}, fmt.Errorf("reopen scheduled task: %w", transitionErr)
		}
	}
	run, err := runner.tasks.CreateRun(ctx, taskValue.ID, "pi")
	if err != nil {
		return scheduler.RunResult{}, fmt.Errorf("create scheduled run: %w", err)
	}
	run.SessionPath = thread.SessionPath
	if err := runner.tasks.UpdateRun(ctx, run); err != nil {
		runner.fail(ctx, run.ID, taskValue.ID, "", err)
		return scheduler.RunResult{}, fmt.Errorf("record scheduled session: %w", err)
	}
	live, err := runner.agent.StartSession(domain.StartSessionRequest{
		ThreadID: thread.ID, Workspace: thread.WorkspacePath,
		SessionPath: thread.SessionPath, SessionName: thread.Title,
		Trust: record.Trust, DisableThemes: true,
	})
	if err != nil {
		runner.fail(ctx, run.ID, taskValue.ID, "", err)
		return scheduler.RunResult{}, fmt.Errorf("start scheduled session: %w", err)
	}
	if sessionFile := sessionFileFromState(live.StateJSON); sessionFile != "" {
		run.SessionPath = sessionFile
		if err := runner.tasks.UpdateRun(ctx, run); err != nil {
			runner.fail(ctx, run.ID, taskValue.ID, thread.ID, err)
			return scheduler.RunResult{}, fmt.Errorf("record scheduled session path: %w", err)
		}
	}
	if _, err := runner.tasks.StartRun(ctx, run.ID); err != nil {
		runner.fail(ctx, run.ID, taskValue.ID, thread.ID, err)
		return scheduler.RunResult{}, fmt.Errorf("start scheduled run: %w", err)
	}
	if value.ModelProvider != "" && value.ModelID != "" {
		if _, err := runner.agent.SetModel(domain.ModelRequest{ThreadID: thread.ID, Provider: value.ModelProvider, ModelID: value.ModelID}); err != nil {
			runner.fail(ctx, run.ID, taskValue.ID, thread.ID, err)
			return scheduler.RunResult{}, fmt.Errorf("apply scheduled model: %w", err)
		}
	}
	if strings.TrimSpace(value.ThinkingLevel) != "" {
		if _, err := runner.agent.SetThinkingLevel(domain.ThinkingRequest{ThreadID: thread.ID, Level: value.ThinkingLevel}); err != nil {
			runner.fail(ctx, run.ID, taskValue.ID, thread.ID, err)
			return scheduler.RunResult{}, fmt.Errorf("apply scheduled thinking level: %w", err)
		}
	}
	if _, err := runner.agent.SendPrompt(domain.PromptRequest{ThreadID: thread.ID, Message: value.Prompt}); err != nil {
		runner.fail(ctx, run.ID, taskValue.ID, thread.ID, err)
		return scheduler.RunResult{}, fmt.Errorf("send scheduled prompt: %w", err)
	}
	return scheduler.RunResult{ThreadID: thread.ID, RunID: run.ID, SessionPath: run.SessionPath}, nil
}

func (runner *ScheduledRunner) fail(ctx context.Context, runID, taskID, threadID string, cause error) {
	if threadID != "" {
		_, _ = runner.agent.Abort(domain.ThreadRequest{ThreadID: threadID})
	}
	if runID != "" {
		_, _ = runner.tasks.FinishRun(ctx, runID, task.StatusFailed, cause.Error())
	}
	if taskID != "" {
		_, _ = runner.tasks.TransitionTask(ctx, taskID, task.StatusFailed)
	}
}

type sessionStateFile struct {
	SessionFile string `json:"sessionFile"`
}

func sessionFileFromState(stateJSON string) string {
	var state sessionStateFile
	if err := json.Unmarshal([]byte(stateJSON), &state); err != nil {
		return ""
	}
	return strings.TrimSpace(state.SessionFile)
}
