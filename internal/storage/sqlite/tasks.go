package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"pi-desk/internal/task"
)

const taskColumns = `id, title, description, status, workspace_id, agent_profile_id, origin, priority, legacy_thread_id, metadata, created_at, updated_at, completed_at`

func (store *Store) CreateTask(ctx context.Context, value task.Task) error {
	_, err := store.write.ExecContext(ctx, `INSERT INTO tasks (`+taskColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		value.ID, value.Title, value.Description, string(value.Status), value.WorkspaceID,
		nullableString(value.AgentProfileID), string(value.Origin), value.Priority,
		nullableString(value.LegacyThreadID), value.Metadata,
		unixMilli(value.CreatedAt), unixMilli(value.UpdatedAt), nullableTime(value.CompletedAt),
	)
	if err != nil {
		return fmt.Errorf("create task: %w", err)
	}
	return nil
}

func (store *Store) GetTask(ctx context.Context, id string) (task.Task, error) {
	row := store.write.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM tasks WHERE id = ?`, id)
	value, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return task.Task{}, task.ErrNotFound
	}
	if err != nil {
		return task.Task{}, fmt.Errorf("get task: %w", err)
	}
	return value, nil
}

func (store *Store) FindTaskByLegacyThreadID(ctx context.Context, threadID string) (task.Task, error) {
	if threadID == "" {
		return task.Task{}, task.ErrNotFound
	}
	row := store.write.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM tasks WHERE legacy_thread_id = ?`, threadID)
	value, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return task.Task{}, task.ErrNotFound
	}
	if err != nil {
		return task.Task{}, fmt.Errorf("find task by thread: %w", err)
	}
	return value, nil
}

func (store *Store) ListTasks(ctx context.Context, limit int) ([]task.Task, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := store.read.QueryContext(ctx, `SELECT `+taskColumns+` FROM tasks ORDER BY updated_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}
	defer rows.Close()
	result := make([]task.Task, 0)
	for rows.Next() {
		value, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("scan task: %w", err)
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}
	return result, nil
}

func (store *Store) UpdateTaskStatus(ctx context.Context, id string, status task.Status, updatedAt time.Time, completedAt *time.Time) error {
	result, err := store.write.ExecContext(ctx,
		`UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
		string(status), unixMilli(updatedAt), nullableTime(completedAt), id,
	)
	if err != nil {
		return fmt.Errorf("update task status: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil {
		return fmt.Errorf("update task status: %w", err)
	} else if affected == 0 {
		return task.ErrNotFound
	}
	return nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanTask(scanner rowScanner) (task.Task, error) {
	var value task.Task
	var status, origin string
	var agentProfile, legacyThread sql.NullString
	var createdAt, updatedAt int64
	var completedAt sql.NullInt64
	err := scanner.Scan(
		&value.ID, &value.Title, &value.Description, &status, &value.WorkspaceID,
		&agentProfile, &origin, &value.Priority, &legacyThread, &value.Metadata,
		&createdAt, &updatedAt, &completedAt,
	)
	if err != nil {
		return task.Task{}, err
	}
	value.Status = task.Status(status)
	value.Origin = task.Origin(origin)
	if agentProfile.Valid {
		value.AgentProfileID = agentProfile.String
	}
	if legacyThread.Valid {
		value.LegacyThreadID = legacyThread.String
	}
	value.CreatedAt = timeFromMilli(createdAt)
	value.UpdatedAt = timeFromMilli(updatedAt)
	if completedAt.Valid {
		completed := timeFromMilli(completedAt.Int64)
		value.CompletedAt = &completed
	}
	return value, nil
}
