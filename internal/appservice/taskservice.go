package appservice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"pi-desk/internal/domain"
	"pi-desk/internal/task"
	"pi-desk/internal/workspace"
)

// TaskService exposes the R1a Task/Run records to the Task Center and owns the
// two write actions the UI needs: cancel the active run, or retry a failed /
// cancelled task from its last user prompt.
type TaskService struct {
	service  *task.Service
	store    task.Store
	agent    TaskAgent
	messages TaskMessageSource
	threads  TaskThreadSource
}

type TaskAgent interface {
	Abort(domain.ThreadRequest) (domain.CommandResult, error)
	StartSession(domain.StartSessionRequest) (domain.LiveSession, error)
	SendPrompt(domain.PromptRequest) (domain.CommandResult, error)
}

type TaskMessageSource interface {
	Messages(path string) ([]json.RawMessage, error)
}

type TaskThreadSource interface {
	Desktop() (workspace.DesktopRecord, error)
}

func NewTaskService(harness *Harness, agent TaskAgent, messages TaskMessageSource, threads TaskThreadSource) *TaskService {
	if harness == nil {
		return &TaskService{agent: agent, messages: messages, threads: threads}
	}
	return &TaskService{service: harness.service, store: harness.store, agent: agent, messages: messages, threads: threads}
}

func (service *TaskService) Enabled() bool {
	return service.service != nil && service.store != nil
}

func (service *TaskService) ListTasks() ([]domain.TaskSummary, error) {
	if service.service == nil {
		return []domain.TaskSummary{}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tasks, err := service.service.ListTasks(ctx, 200)
	if err != nil {
		return nil, err
	}
	result := make([]domain.TaskSummary, 0, len(tasks))
	for _, value := range tasks {
		result = append(result, taskSummary(value))
	}
	return result, nil
}

func (service *TaskService) GetTask(request domain.TaskRequest) (domain.TaskDetail, error) {
	if service.service == nil {
		return domain.TaskDetail{}, errors.New("task data is disabled; start Pi Desk with PI_DESK_HARNESS=1")
	}
	taskID := strings.TrimSpace(request.TaskID)
	if taskID == "" {
		return domain.TaskDetail{}, errors.New("task id is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	value, err := service.service.GetTask(ctx, taskID)
	if err != nil {
		return domain.TaskDetail{}, err
	}
	runs, err := service.service.ListRuns(ctx, taskID)
	if err != nil {
		return domain.TaskDetail{}, err
	}
	detail := domain.TaskDetail{TaskSummary: taskSummary(value), Runs: make([]domain.TaskRunSummary, 0, len(runs))}
	for _, run := range runs {
		summary := runSummary(run)
		if service.store != nil {
			if usage, usageErr := service.store.GetUsage(ctx, run.ID); usageErr == nil {
				summary.Usage = usageSummary(usage)
			} else if !errors.Is(usageErr, task.ErrNotFound) {
				return domain.TaskDetail{}, usageErr
			}
		}
		detail.Runs = append(detail.Runs, summary)
	}
	return detail, nil
}

func (service *TaskService) ListRunEvents(request domain.TaskEventsRequest) ([]domain.TaskEventView, error) {
	if service.store == nil {
		return []domain.TaskEventView{}, nil
	}
	runID := strings.TrimSpace(request.RunID)
	if runID == "" {
		return nil, errors.New("run id is required")
	}
	limit := request.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	events, err := service.store.ListEvents(ctx, runID, request.AfterSeq)
	if err != nil {
		return nil, err
	}
	if len(events) > limit {
		events = events[:limit]
	}
	result := make([]domain.TaskEventView, 0, len(events))
	for _, event := range events {
		result = append(result, domain.TaskEventView{
			ID: event.ID, RunID: event.RunID, Type: event.Type, Seq: event.Seq,
			Payload: string(event.Payload), Redacted: event.Redacted, Truncated: event.Truncated,
			CreatedAt: event.CreatedAt.UnixMilli(),
		})
	}
	return result, nil
}

func (service *TaskService) GetRunUsage(request domain.TaskRunRequest) (domain.TaskUsageSummary, error) {
	if service.store == nil {
		return domain.TaskUsageSummary{}, nil
	}
	runID := strings.TrimSpace(request.RunID)
	if runID == "" {
		return domain.TaskUsageSummary{}, errors.New("run id is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	usage, err := service.store.GetUsage(ctx, runID)
	if errors.Is(err, task.ErrNotFound) {
		return domain.TaskUsageSummary{}, nil
	}
	if err != nil {
		return domain.TaskUsageSummary{}, fmt.Errorf("get run usage: %w", err)
	}
	return *usageSummary(usage), nil
}

func (service *TaskService) CancelTask(request domain.TaskRequest) (domain.TaskDetail, error) {
	if service.service == nil {
		return domain.TaskDetail{}, errors.New("task data is disabled; start Pi Desk with PI_DESK_HARNESS=1")
	}
	taskID := strings.TrimSpace(request.TaskID)
	if taskID == "" {
		return domain.TaskDetail{}, errors.New("task id is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	value, err := service.service.GetTask(ctx, taskID)
	if err != nil {
		return domain.TaskDetail{}, err
	}
	runs, err := service.service.ListRuns(ctx, taskID)
	if err != nil {
		return domain.TaskDetail{}, err
	}
	active := make([]task.Run, 0)
	for _, run := range runs {
		if run.Status == task.StatusQueued || run.Status == task.StatusRunning ||
			run.Status == task.StatusWaitingApproval || run.Status == task.StatusWaitingInput {
			active = append(active, run)
		}
	}
	threadID := strings.TrimSpace(value.LegacyThreadID)
	for _, run := range active {
		if run.Status == task.StatusRunning && service.agent != nil && threadID != "" {
			if _, err := service.agent.Abort(domain.ThreadRequest{ThreadID: threadID}); err != nil && !isThreadNotRunning(err) {
				return domain.TaskDetail{}, fmt.Errorf("abort run: %w", err)
			}
		}
	}
	for _, run := range active {
		if _, err := service.service.FinishRun(ctx, run.ID, task.StatusCancelled, "cancelled from Task Center"); err != nil && !errors.Is(err, task.ErrInvalidTransition) {
			return domain.TaskDetail{}, err
		}
	}
	if !task.IsTerminal(value.Status) {
		if _, err := service.service.TransitionTask(ctx, value.ID, task.StatusCancelled); err != nil && !errors.Is(err, task.ErrInvalidTransition) {
			return domain.TaskDetail{}, err
		}
	}
	return service.GetTask(request)
}

func (service *TaskService) RetryTask(request domain.TaskRequest) (domain.TaskDetail, error) {
	if service.service == nil {
		return domain.TaskDetail{}, errors.New("task data is disabled; start Pi Desk with PI_DESK_HARNESS=1")
	}
	if service.agent == nil || service.messages == nil || service.threads == nil {
		return domain.TaskDetail{}, errors.New("task retry is unavailable in this build")
	}
	taskID := strings.TrimSpace(request.TaskID)
	if taskID == "" {
		return domain.TaskDetail{}, errors.New("task id is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	value, err := service.service.GetTask(ctx, taskID)
	if err != nil {
		return domain.TaskDetail{}, err
	}
	if value.Status != task.StatusFailed && value.Status != task.StatusCancelled {
		return domain.TaskDetail{}, errors.New("only failed or cancelled tasks can be retried")
	}
	threadID := strings.TrimSpace(value.LegacyThreadID)
	if threadID == "" {
		return domain.TaskDetail{}, errors.New("task has no thread binding")
	}
	desktop, err := service.threads.Desktop()
	if err != nil {
		return domain.TaskDetail{}, err
	}
	var thread *workspace.ThreadRecord
	for index := range desktop.Threads {
		if desktop.Threads[index].ID == threadID {
			thread = &desktop.Threads[index]
			break
		}
	}
	if thread == nil || strings.TrimSpace(thread.SessionPath) == "" {
		return domain.TaskDetail{}, errors.New("task has no resumable session")
	}
	if strings.TrimSpace(thread.WorkspacePath) == "" {
		return domain.TaskDetail{}, errors.New("retry is not supported for remote workspaces yet")
	}
	messages, err := service.messages.Messages(thread.SessionPath)
	if err != nil {
		return domain.TaskDetail{}, err
	}
	prompt, err := lastUserPrompt(messages)
	if err != nil {
		return domain.TaskDetail{}, err
	}

	value, err = service.service.TransitionTask(ctx, value.ID, task.StatusQueued)
	if err != nil {
		return domain.TaskDetail{}, err
	}
	run, err := service.service.CreateRun(ctx, value.ID, "pi")
	if err != nil {
		return domain.TaskDetail{}, err
	}
	run.SessionPath = thread.SessionPath
	if err := service.store.UpdateRun(ctx, run); err != nil {
		return domain.TaskDetail{}, err
	}
	if _, err := service.agent.StartSession(domain.StartSessionRequest{
		ThreadID: thread.ID, Workspace: thread.WorkspacePath, SessionPath: thread.SessionPath,
		SessionName: thread.Title, Trust: thread.Trust,
	}); err != nil {
		service.failRetry(ctx, run.ID, value.ID, err)
		return domain.TaskDetail{}, err
	}
	if _, err := service.service.StartRun(ctx, run.ID); err != nil {
		return domain.TaskDetail{}, err
	}
	if _, err := service.agent.SendPrompt(domain.PromptRequest{ThreadID: thread.ID, Message: prompt}); err != nil {
		service.failRetry(ctx, run.ID, value.ID, err)
		return domain.TaskDetail{}, err
	}
	return service.GetTask(request)
}

func (service *TaskService) failRetry(ctx context.Context, runID, taskID string, cause error) {
	_, _ = service.service.FinishRun(ctx, runID, task.StatusFailed, cause.Error())
	_, _ = service.service.TransitionTask(ctx, taskID, task.StatusFailed)
}

func lastUserPrompt(messages []json.RawMessage) (string, error) {
	for index := len(messages) - 1; index >= 0; index-- {
		var envelope struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(messages[index], &envelope); err != nil || envelope.Role != "user" {
			continue
		}
		if text := contentPlainText(envelope.Content); strings.TrimSpace(text) != "" {
			return text, nil
		}
	}
	return "", errors.New("no user prompt is available to retry")
}

func contentPlainText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	var builder strings.Builder
	for _, part := range parts {
		if part.Type == "text" {
			builder.WriteString(part.Text)
		}
	}
	return builder.String()
}

func isThreadNotRunning(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "not running")
}

func taskSummary(value task.Task) domain.TaskSummary {
	summary := domain.TaskSummary{
		ID: value.ID, Title: value.Title, Status: string(value.Status),
		Origin: string(value.Origin), WorkspaceID: value.WorkspaceID,
		Priority: value.Priority, LegacyThreadID: value.LegacyThreadID,
		CreatedAt: value.CreatedAt.UnixMilli(), UpdatedAt: value.UpdatedAt.UnixMilli(),
	}
	if value.CompletedAt != nil {
		summary.CompletedAt = value.CompletedAt.UnixMilli()
	}
	return summary
}

func runSummary(value task.Run) domain.TaskRunSummary {
	summary := domain.TaskRunSummary{
		ID: value.ID, TaskID: value.TaskID, Runtime: value.Runtime,
		Status: string(value.Status), SessionPath: value.SessionPath,
		ModelProvider: value.ModelProvider, ModelID: value.ModelID,
		Error: value.Error, Attempt: value.Attempt, Generation: value.Generation,
		CreatedAt: value.CreatedAt.UnixMilli(),
	}
	if value.StartedAt != nil {
		summary.StartedAt = value.StartedAt.UnixMilli()
	}
	if value.FinishedAt != nil {
		summary.FinishedAt = value.FinishedAt.UnixMilli()
	}
	return summary
}

func usageSummary(value task.Usage) *domain.TaskUsageSummary {
	return &domain.TaskUsageSummary{
		InputTokens: value.InputTokens, OutputTokens: value.OutputTokens,
		CacheReadTokens: value.CacheReadTokens, CacheWriteTokens: value.CacheWriteTokens,
		EstimatedCost: value.EstimatedCost, CreatedAt: value.CreatedAt.UnixMilli(),
	}
}
