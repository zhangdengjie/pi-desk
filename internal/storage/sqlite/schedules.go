package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"pi-desk/internal/schedule"
)

const scheduleColumns = `
	id, task_id, name, prompt, workspace_id,
	COALESCE(model_provider, ''), COALESCE(model_id, ''), COALESCE(model_name, ''), COALESCE(thinking_level, ''),
	kind, COALESCE(time_of_day, ''), COALESCE(weekday, 0), run_at, timezone, enabled, catch_up,
	next_run_at, last_run_at, last_catch_up_at, last_status, last_error, last_thread_id, created_at, updated_at`

func (store *Store) CreateSchedule(ctx context.Context, value schedule.Schedule) error {
	_, err := store.write.ExecContext(ctx, `
		INSERT INTO task_schedules (
			id, task_id, name, prompt, workspace_id,
			model_provider, model_id, model_name, thinking_level,
			kind, time_of_day, weekday, run_at, timezone, enabled, catch_up,
			next_run_at, last_run_at, last_catch_up_at, last_status, last_error, last_thread_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		value.ID, value.TaskID, value.Name, value.Prompt, value.WorkspaceID,
		nullableString(value.ModelProvider), nullableString(value.ModelID), nullableString(value.ModelName), nullableString(value.ThinkingLevel),
		string(value.Frequency), nullableString(value.Time), nullableScheduleWeekday(value), nullableTime(value.RunAt), value.Timezone,
		boolInt(value.Enabled), boolInt(value.CatchUp),
		nullableTime(value.NextRunAt), nullableTime(value.LastRunAt), nullableTime(value.LastCatchUpAt),
		string(value.LastStatus), value.LastError, value.LastThreadID, unixMilli(value.CreatedAt), unixMilli(value.UpdatedAt),
	)
	if err != nil {
		return fmt.Errorf("create schedule: %w", err)
	}
	return nil
}

func (store *Store) GetSchedule(ctx context.Context, id string) (schedule.Schedule, error) {
	row := store.read.QueryRowContext(ctx, `SELECT `+scheduleColumns+` FROM task_schedules WHERE id = ?`, id)
	value, err := scanSchedule(row)
	if errors.Is(err, sql.ErrNoRows) {
		return schedule.Schedule{}, schedule.ErrNotFound
	}
	if err != nil {
		return schedule.Schedule{}, fmt.Errorf("get schedule: %w", err)
	}
	return value, nil
}

func (store *Store) ListSchedules(ctx context.Context) ([]schedule.Schedule, error) {
	rows, err := store.read.QueryContext(ctx, `SELECT `+scheduleColumns+` FROM task_schedules ORDER BY updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list schedules: %w", err)
	}
	defer rows.Close()
	var result []schedule.Schedule
	for rows.Next() {
		value, scanErr := scanSchedule(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("scan schedule: %w", scanErr)
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate schedules: %w", err)
	}
	return result, nil
}

func (store *Store) ListDueSchedules(ctx context.Context, now time.Time, limit int) ([]schedule.Schedule, error) {
	if limit <= 0 {
		limit = 64
	}
	rows, err := store.read.QueryContext(ctx, `SELECT `+scheduleColumns+`
		FROM task_schedules
		WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
		ORDER BY next_run_at ASC LIMIT ?`, unixMilli(now), limit)
	if err != nil {
		return nil, fmt.Errorf("list due schedules: %w", err)
	}
	defer rows.Close()
	var result []schedule.Schedule
	for rows.Next() {
		value, scanErr := scanSchedule(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("scan due schedule: %w", scanErr)
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate due schedules: %w", err)
	}
	return result, nil
}

func (store *Store) UpdateSchedule(ctx context.Context, value schedule.Schedule) error {
	result, err := store.write.ExecContext(ctx, `
		UPDATE task_schedules SET
			task_id = ?, name = ?, prompt = ?, workspace_id = ?,
			model_provider = ?, model_id = ?, model_name = ?, thinking_level = ?,
			kind = ?, time_of_day = ?, weekday = ?, run_at = ?, timezone = ?, enabled = ?, catch_up = ?,
			next_run_at = ?, last_run_at = ?, last_catch_up_at = ?, last_status = ?, last_error = ?, last_thread_id = ?,
			updated_at = ?
		WHERE id = ?`,
		value.TaskID, value.Name, value.Prompt, value.WorkspaceID,
		nullableString(value.ModelProvider), nullableString(value.ModelID), nullableString(value.ModelName), nullableString(value.ThinkingLevel),
		string(value.Frequency), nullableString(value.Time), nullableScheduleWeekday(value), nullableTime(value.RunAt), value.Timezone,
		boolInt(value.Enabled), boolInt(value.CatchUp),
		nullableTime(value.NextRunAt), nullableTime(value.LastRunAt), nullableTime(value.LastCatchUpAt),
		string(value.LastStatus), value.LastError, value.LastThreadID, unixMilli(value.UpdatedAt), value.ID,
	)
	if err != nil {
		return fmt.Errorf("update schedule: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("update schedule rows: %w", err)
	}
	if affected == 0 {
		return schedule.ErrNotFound
	}
	return nil
}

func (store *Store) DeleteSchedule(ctx context.Context, id string) error {
	result, err := store.write.ExecContext(ctx, `DELETE FROM task_schedules WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete schedule: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete schedule rows: %w", err)
	}
	if affected == 0 {
		return schedule.ErrNotFound
	}
	return nil
}

type scheduleScanner interface {
	Scan(dest ...any) error
}

func scanSchedule(scanner scheduleScanner) (schedule.Schedule, error) {
	var (
		value                                  schedule.Schedule
		kind, lastStatus                       string
		runAt, nextRunAt, lastRunAt, catchUpAt sql.NullInt64
		enabled, catchUp                       int
		createdAt, updatedAt                   int64
	)
	err := scanner.Scan(
		&value.ID, &value.TaskID, &value.Name, &value.Prompt, &value.WorkspaceID,
		&value.ModelProvider, &value.ModelID, &value.ModelName, &value.ThinkingLevel,
		&kind, &value.Time, &value.Weekday, &runAt, &value.Timezone, &enabled, &catchUp,
		&nextRunAt, &lastRunAt, &catchUpAt, &lastStatus, &value.LastError, &value.LastThreadID, &createdAt, &updatedAt,
	)
	if err != nil {
		return schedule.Schedule{}, err
	}
	value.Frequency = schedule.Frequency(kind)
	value.LastStatus = schedule.RunStatus(lastStatus)
	value.RunAt = scheduleTimePointer(runAt)
	value.NextRunAt = scheduleTimePointer(nextRunAt)
	value.LastRunAt = scheduleTimePointer(lastRunAt)
	value.LastCatchUpAt = scheduleTimePointer(catchUpAt)
	value.Enabled = enabled != 0
	value.CatchUp = catchUp != 0
	value.CreatedAt = timeFromMilli(createdAt)
	value.UpdatedAt = timeFromMilli(updatedAt)
	return value, nil
}

func nullableScheduleWeekday(value schedule.Schedule) any {
	if value.Frequency != schedule.FrequencyWeekly {
		return nil
	}
	return value.Weekday
}

func scheduleTimePointer(value sql.NullInt64) *time.Time {
	if !value.Valid {
		return nil
	}
	parsed := timeFromMilli(value.Int64)
	return &parsed
}
