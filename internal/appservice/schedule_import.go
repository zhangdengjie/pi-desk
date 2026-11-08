package appservice

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"pi-desk/internal/schedule"
	"pi-desk/internal/task"
	"pi-desk/internal/workspace"
)

// importLegacySchedules moves desktop.scheduledTasks into task_schedules once.
// It is idempotent by schedule id and reuses an already imported thread Task
// when lastThreadId points at one. The caller runs it before the window loads,
// so it never races the frontend's whole-desktop save.
func importLegacySchedules(ctx context.Context, schedules *schedule.Service, tasks *task.Service, catalog *workspace.Catalog) (created, skipped int, err error) {
	if schedules == nil || tasks == nil || catalog == nil {
		return 0, 0, nil
	}
	desktop, err := catalog.Desktop()
	if err != nil {
		return 0, 0, err
	}
	now := time.Now().UTC()
	for _, record := range desktop.ScheduledTasks {
		if _, getErr := schedules.Get(ctx, record.ID); getErr == nil {
			skipped++
			continue
		} else if !errors.Is(getErr, schedule.ErrNotFound) {
			return created, skipped, getErr
		}

		taskID := ""
		if strings.TrimSpace(record.LastThreadID) != "" {
			existing, findErr := tasks.FindTaskByLegacyThreadID(ctx, record.LastThreadID)
			switch {
			case findErr == nil:
				taskID = existing.ID
			case errors.Is(findErr, task.ErrNotFound):
			default:
				return created, skipped, fmt.Errorf("find schedule task %s: %w", record.ID, findErr)
			}
		}
		if taskID == "" {
			value, createErr := tasks.CreateTask(ctx, task.CreateTaskInput{
				Title:          record.Name,
				Description:    record.Prompt,
				WorkspaceID:    record.WorkspaceID,
				Origin:         task.OriginScheduled,
				LegacyThreadID: record.LastThreadID,
			})
			if createErr != nil {
				return created, skipped, fmt.Errorf("create schedule task %s: %w", record.ID, createErr)
			}
			taskID = value.ID
		}

		value := schedule.Schedule{
			ID:            record.ID,
			TaskID:        taskID,
			Name:          record.Name,
			Prompt:        record.Prompt,
			WorkspaceID:   record.WorkspaceID,
			ModelProvider: record.ModelProvider,
			ModelID:       record.ModelID,
			ModelName:     record.ModelName,
			ThinkingLevel: record.ThinkingLevel,
			Frequency:     schedule.Frequency(record.Frequency),
			Time:          record.Time,
			Weekday:       record.Weekday,
			RunAt:         parseScheduleTime(record.RunAt),
			Timezone:      "local",
			Enabled:       record.Enabled,
			CatchUp:       true,
			NextRunAt:     parseScheduleTime(record.NextRunAt),
			LastRunAt:     parseScheduleTime(record.LastRunAt),
			LastStatus:    schedule.RunStatus(record.LastStatus),
			LastError:     record.LastError,
			LastThreadID:  record.LastThreadID,
			CreatedAt:     firstScheduleTime(parseScheduleTime(record.CreatedAt), now),
			UpdatedAt:     firstScheduleTime(parseScheduleTime(record.UpdatedAt), now),
		}
		if value.NextRunAt == nil && value.Enabled {
			if next, ok := schedule.Next(value, now); ok {
				next = next.UTC()
				value.NextRunAt = &next
			} else {
				value.Enabled = false
			}
		}
		if _, createErr := schedules.Import(ctx, value); createErr != nil {
			return created, skipped, fmt.Errorf("import schedule %s: %w", record.ID, createErr)
		}
		created++
	}
	return created, skipped, nil
}

func parseScheduleTime(value string) *time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return nil
	}
	parsed = parsed.UTC()
	return &parsed
}

func firstScheduleTime(value *time.Time, fallback time.Time) time.Time {
	if value != nil {
		return *value
	}
	return fallback
}
