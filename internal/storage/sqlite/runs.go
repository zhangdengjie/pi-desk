package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"pi-desk/internal/task"
)

const runColumns = `id, task_id, runtime, session_path, model_provider, model_id, status, attempt, generation, error, created_at, started_at, finished_at`

func (store *Store) CreateRun(ctx context.Context, value task.Run) error {
	_, err := store.write.ExecContext(ctx, `INSERT INTO task_runs (`+runColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		value.ID, value.TaskID, value.Runtime, nullableString(value.SessionPath),
		nullableString(value.ModelProvider), nullableString(value.ModelID), string(value.Status),
		value.Attempt, value.Generation, nullableString(value.Error),
		unixMilli(value.CreatedAt), nullableTime(value.StartedAt), nullableTime(value.FinishedAt),
	)
	if err != nil {
		return fmt.Errorf("create run: %w", err)
	}
	return nil
}

func (store *Store) GetRun(ctx context.Context, id string) (task.Run, error) {
	row := store.write.QueryRowContext(ctx, `SELECT `+runColumns+` FROM task_runs WHERE id = ?`, id)
	value, err := scanRun(row)
	if errors.Is(err, sql.ErrNoRows) {
		return task.Run{}, task.ErrNotFound
	}
	if err != nil {
		return task.Run{}, fmt.Errorf("get run: %w", err)
	}
	return value, nil
}

func (store *Store) ListRuns(ctx context.Context, taskID string) ([]task.Run, error) {
	rows, err := store.write.QueryContext(ctx, `SELECT `+runColumns+` FROM task_runs WHERE task_id = ? ORDER BY created_at ASC`, taskID)
	if err != nil {
		return nil, fmt.Errorf("list runs: %w", err)
	}
	defer rows.Close()
	result := make([]task.Run, 0)
	for rows.Next() {
		value, err := scanRun(rows)
		if err != nil {
			return nil, fmt.Errorf("scan run: %w", err)
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list runs: %w", err)
	}
	return result, nil
}

func (store *Store) UpdateRun(ctx context.Context, value task.Run) error {
	result, err := store.write.ExecContext(ctx,
		`UPDATE task_runs SET runtime = ?, session_path = ?, model_provider = ?, model_id = ?,
		 status = ?, attempt = ?, generation = ?, error = ?, started_at = ?, finished_at = ?
		 WHERE id = ?`,
		value.Runtime, nullableString(value.SessionPath), nullableString(value.ModelProvider),
		nullableString(value.ModelID), string(value.Status), value.Attempt, value.Generation,
		nullableString(value.Error), nullableTime(value.StartedAt), nullableTime(value.FinishedAt), value.ID,
	)
	if err != nil {
		return fmt.Errorf("update run: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil {
		return fmt.Errorf("update run: %w", err)
	} else if affected == 0 {
		return task.ErrNotFound
	}
	return nil
}

func (store *Store) MaxEventSeq(ctx context.Context, runID string) (uint64, error) {
	var seq int64
	err := store.write.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq), 0) FROM run_events WHERE run_id = ?`, runID).Scan(&seq)
	if err != nil {
		return 0, fmt.Errorf("max event seq: %w", err)
	}
	return uint64(seq), nil
}

func scanRun(scanner rowScanner) (task.Run, error) {
	var value task.Run
	var sessionPath, provider, model, message sql.NullString
	var status string
	var createdAt, attempt, generation int64
	var startedAt, finishedAt sql.NullInt64
	err := scanner.Scan(
		&value.ID, &value.TaskID, &value.Runtime, &sessionPath, &provider, &model,
		&status, &attempt, &generation, &message, &createdAt, &startedAt, &finishedAt,
	)
	if err != nil {
		return task.Run{}, err
	}
	value.Status = task.Status(status)
	if sessionPath.Valid {
		value.SessionPath = sessionPath.String
	}
	if provider.Valid {
		value.ModelProvider = provider.String
	}
	if model.Valid {
		value.ModelID = model.String
	}
	if message.Valid {
		value.Error = message.String
	}
	value.Attempt = int(attempt)
	value.Generation = uint64(generation)
	value.CreatedAt = timeFromMilli(createdAt)
	if startedAt.Valid {
		started := timeFromMilli(startedAt.Int64)
		value.StartedAt = &started
	}
	if finishedAt.Valid {
		finished := timeFromMilli(finishedAt.Int64)
		value.FinishedAt = &finished
	}
	return value, nil
}
