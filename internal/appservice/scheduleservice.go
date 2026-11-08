package appservice

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"pi-desk/internal/domain"
	"pi-desk/internal/schedule"
	"pi-desk/internal/scheduler"
	"pi-desk/internal/task"
)

type ScheduleService struct {
	schedules *schedule.Service
	tasks     *task.Service
	runner    scheduler.Runner
}

func NewScheduleService(schedules *schedule.Service, tasks *task.Service, runner scheduler.Runner) *ScheduleService {
	return &ScheduleService{schedules: schedules, tasks: tasks, runner: runner}
}

func (service *ScheduleService) Enabled() bool {
	return R2SchedulerEnabled() && service.schedules != nil
}

func (service *ScheduleService) ListSchedules() ([]domain.ScheduleSummary, error) {
	if !service.Enabled() {
		return nil, nil
	}
	values, err := service.schedules.List(context.Background())
	if err != nil {
		return nil, err
	}
	result := make([]domain.ScheduleSummary, 0, len(values))
	for _, value := range values {
		result = append(result, scheduleSummary(service.reconcile(context.Background(), value)))
	}
	return result, nil
}

// reconcile turns the schedule's "started" marker into the real Run terminal
// state. The scheduler only knows that the prompt was handed to Pi; the task
// run is the source of truth for completion.
func (service *ScheduleService) reconcile(ctx context.Context, value schedule.Schedule) schedule.Schedule {
	if value.LastStatus != schedule.StatusStarted || service.tasks == nil || strings.TrimSpace(value.TaskID) == "" {
		return value
	}
	runs, err := service.tasks.ListRuns(ctx, value.TaskID)
	if err != nil || len(runs) == 0 {
		return value
	}
	latest := runs[len(runs)-1]
	switch latest.Status {
	case task.StatusCompleted:
		value.LastStatus = schedule.StatusCompleted
		value.LastError = ""
	case task.StatusFailed:
		value.LastStatus = schedule.StatusFailed
		value.LastError = latest.Error
	case task.StatusCancelled:
		value.LastStatus = schedule.StatusCancelled
		value.LastError = ""
	default:
		return value
	}
	updated, err := service.schedules.Update(ctx, value)
	if err != nil {
		return value
	}
	return updated
}

// RunNow starts one manual Run without moving nextRunAt. The regular scheduler
// remains responsible for recurring timing.
func (service *ScheduleService) RunNow(request domain.ScheduleIDRequest) (domain.ScheduleRunResult, error) {
	if !service.Enabled() {
		return domain.ScheduleRunResult{}, errors.New("schedule service is disabled; set PI_DESK_R2_SCHEDULER=1 to enable it")
	}
	if service.runner == nil {
		return domain.ScheduleRunResult{}, errors.New("scheduled runner is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	value, err := service.schedules.Get(ctx, strings.TrimSpace(request.ScheduleID))
	if err != nil {
		return domain.ScheduleRunResult{}, err
	}
	started := time.Now().UTC()
	_, _ = service.schedules.SetRuntime(ctx, value.ID, started, schedule.StatusStarted, value.LastThreadID, "")
	result, runErr := service.runner.RunScheduled(ctx, value)
	if runErr != nil {
		status := schedule.StatusFailed
		if errors.Is(runErr, scheduler.ErrBusy) {
			status = schedule.StatusSkipped
		}
		_, _ = service.schedules.SetRuntime(ctx, value.ID, started, status, result.ThreadID, runErr.Error())
		return domain.ScheduleRunResult{}, runErr
	}
	_, _ = service.schedules.SetRuntime(ctx, value.ID, started, schedule.StatusStarted, result.ThreadID, "")
	return domain.ScheduleRunResult{
		ScheduleID: value.ID, ThreadID: result.ThreadID, RunID: result.RunID, SessionPath: result.SessionPath,
	}, nil
}

func (service *ScheduleService) SaveSchedule(request domain.ScheduleSaveRequest) (domain.ScheduleSummary, error) {
	if !service.Enabled() {
		return domain.ScheduleSummary{}, errors.New("schedule service is disabled; set PI_DESK_R2_SCHEDULER=1 to enable it")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	runAt, err := parseDomainTime(request.RunAt)
	if err != nil {
		return domain.ScheduleSummary{}, fmt.Errorf("runAt: %w", err)
	}
	nextRunAt, err := parseDomainTime(request.NextRunAt)
	if err != nil {
		return domain.ScheduleSummary{}, fmt.Errorf("nextRunAt: %w", err)
	}
	id := strings.TrimSpace(request.ID)
	if id == "" {
		value, createErr := service.schedules.Create(ctx, schedule.CreateInput{
			TaskID: request.TaskID, Name: request.Name, Prompt: request.Prompt,
			WorkspaceID: request.WorkspaceID, ModelProvider: request.ModelProvider,
			ModelID: request.ModelID, ModelName: request.ModelName, ThinkingLevel: request.ThinkingLevel,
			Frequency: schedule.Frequency(request.Frequency), Time: request.Time,
			Weekday: request.Weekday, RunAt: runAt, NextRunAt: nextRunAt,
			Timezone: request.Timezone, Enabled: request.Enabled, CatchUp: request.CatchUp,
			LastThreadID: request.LastThreadID,
		})
		if createErr != nil {
			return domain.ScheduleSummary{}, createErr
		}
		return scheduleSummary(value), nil
	}

	value, err := service.schedules.Get(ctx, id)
	if err != nil {
		return domain.ScheduleSummary{}, err
	}
	value.TaskID = strings.TrimSpace(request.TaskID)
	value.Name = strings.TrimSpace(request.Name)
	value.Prompt = strings.TrimSpace(request.Prompt)
	value.WorkspaceID = strings.TrimSpace(request.WorkspaceID)
	value.ModelProvider = strings.TrimSpace(request.ModelProvider)
	value.ModelID = strings.TrimSpace(request.ModelID)
	value.ModelName = strings.TrimSpace(request.ModelName)
	value.ThinkingLevel = strings.TrimSpace(request.ThinkingLevel)
	value.Frequency = schedule.Frequency(request.Frequency)
	value.Time = strings.TrimSpace(request.Time)
	value.Weekday = request.Weekday
	value.RunAt = runAt
	value.Timezone = strings.TrimSpace(request.Timezone)
	if value.Timezone == "" {
		value.Timezone = "local"
	}
	value.Enabled = request.Enabled
	value.CatchUp = request.CatchUp
	value.LastThreadID = strings.TrimSpace(request.LastThreadID)
	value.NextRunAt = nextRunAt
	if value.Enabled && value.NextRunAt == nil {
		if next, ok := schedule.Next(value, time.Now()); ok {
			next = next.UTC()
			value.NextRunAt = &next
		}
	}
	updated, err := service.schedules.Update(ctx, value)
	if err != nil {
		return domain.ScheduleSummary{}, err
	}
	return scheduleSummary(updated), nil
}

func (service *ScheduleService) DeleteSchedule(request domain.ScheduleIDRequest) error {
	if !service.Enabled() {
		return errors.New("schedule service is disabled; set PI_DESK_R2_SCHEDULER=1 to enable it")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return service.schedules.Delete(ctx, request.ScheduleID)
}

func scheduleSummary(value schedule.Schedule) domain.ScheduleSummary {
	return domain.ScheduleSummary{
		ID: value.ID, TaskID: value.TaskID, Name: value.Name, Prompt: value.Prompt,
		WorkspaceID: value.WorkspaceID, ModelProvider: value.ModelProvider,
		ModelID: value.ModelID, ModelName: value.ModelName, ThinkingLevel: value.ThinkingLevel,
		Frequency: string(value.Frequency), Time: value.Time, Weekday: value.Weekday,
		RunAt: formatDomainTime(value.RunAt), Timezone: value.Timezone,
		Enabled: value.Enabled, CatchUp: value.CatchUp,
		NextRunAt: formatDomainTime(value.NextRunAt), LastRunAt: formatDomainTime(value.LastRunAt),
		LastCatchUpAt: formatDomainTime(value.LastCatchUpAt),
		LastStatus:    string(value.LastStatus), LastError: value.LastError, LastThreadID: value.LastThreadID,
		CreatedAt: value.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt: value.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func parseDomainTime(value string) (*time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return nil, err
	}
	parsed = parsed.UTC()
	return &parsed, nil
}

func formatDomainTime(value *time.Time) string {
	if value == nil || value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339)
}
