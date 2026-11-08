package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"pi-desk/internal/task"
)

func (store *Store) UpsertUsage(ctx context.Context, usage task.Usage) error {
	if usage.ID == "" {
		usage.ID = "usage_" + usage.RunID
	}
	_, err := store.write.ExecContext(ctx,
		`INSERT INTO usage_records (
			id, run_id, provider, model, input_tokens, output_tokens,
			cache_read_tokens, cache_write_tokens, estimated_cost, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(run_id) DO UPDATE SET
			provider = excluded.provider,
			model = excluded.model,
			input_tokens = excluded.input_tokens,
			output_tokens = excluded.output_tokens,
			cache_read_tokens = excluded.cache_read_tokens,
			cache_write_tokens = excluded.cache_write_tokens,
			estimated_cost = excluded.estimated_cost`,
		usage.ID, usage.RunID, nullableString(usage.Provider), nullableString(usage.Model),
		usage.InputTokens, usage.OutputTokens, usage.CacheReadTokens, usage.CacheWriteTokens,
		usage.EstimatedCost, unixMilli(usage.CreatedAt),
	)
	if err != nil {
		return fmt.Errorf("upsert usage: %w", err)
	}
	return nil
}

func (store *Store) GetUsage(ctx context.Context, runID string) (task.Usage, error) {
	var usage task.Usage
	var provider, model sql.NullString
	var createdAt int64
	err := store.read.QueryRowContext(ctx,
		`SELECT id, run_id, provider, model, input_tokens, output_tokens,
			cache_read_tokens, cache_write_tokens, estimated_cost, created_at
		 FROM usage_records WHERE run_id = ?`, runID,
	).Scan(
		&usage.ID, &usage.RunID, &provider, &model, &usage.InputTokens, &usage.OutputTokens,
		&usage.CacheReadTokens, &usage.CacheWriteTokens, &usage.EstimatedCost, &createdAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return task.Usage{}, task.ErrNotFound
	}
	if err != nil {
		return task.Usage{}, fmt.Errorf("get usage: %w", err)
	}
	if provider.Valid {
		usage.Provider = provider.String
	}
	if model.Valid {
		usage.Model = model.String
	}
	usage.CreatedAt = timeFromMilli(createdAt)
	return usage, nil
}
