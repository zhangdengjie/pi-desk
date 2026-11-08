package appservice

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"pi-desk/internal/domain"
	"pi-desk/internal/task"
)

// TaskService exposes the R1a Task/Run records to the Task Center. It is
// read-only in R1b; cancel/retry/archive are added after the UI has proven the
// read path.
type TaskService struct {
	service *task.Service
	store   task.Store
}

func NewTaskService(harness *Harness) *TaskService {
	if harness == nil {
		return &TaskService{}
	}
	return &TaskService{service: harness.service, store: harness.store}
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
