package sqlite

import (
	"context"
	"database/sql"
	"fmt"

	"pi-desk/internal/task"
)

const eventColumns = `id, run_id, seq, type, payload, payload_sha256, payload_bytes, redacted, truncated, created_at`

func (store *Store) AppendEvent(ctx context.Context, event task.Event) error {
	payload := string(event.Payload)
	if payload == "" {
		payload = "{}"
	}
	result, err := store.write.ExecContext(ctx,
		`INSERT OR IGNORE INTO run_events (`+eventColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		event.ID, event.RunID, event.Seq, event.Type, payload,
		nullableString(event.PayloadSHA256), event.PayloadBytes,
		boolInt(event.Redacted), boolInt(event.Truncated), unixMilli(event.CreatedAt),
	)
	if err != nil {
		return fmt.Errorf("append event: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil {
		return fmt.Errorf("append event: %w", err)
	} else if affected == 0 {
		// (run_id, seq) already exists; event ingestion is idempotent.
		return nil
	}
	return nil
}

func (store *Store) ListEvents(ctx context.Context, runID string, afterSeq uint64) ([]task.Event, error) {
	rows, err := store.read.QueryContext(ctx,
		`SELECT `+eventColumns+` FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC`,
		runID, afterSeq,
	)
	if err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}
	defer rows.Close()
	result := make([]task.Event, 0)
	for rows.Next() {
		event, err := scanEvent(rows)
		if err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		result = append(result, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}
	return result, nil
}

func (store *Store) CountEvents(ctx context.Context, runID string) (int, error) {
	var count int
	err := store.read.QueryRowContext(ctx, `SELECT COUNT(*) FROM run_events WHERE run_id = ?`, runID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count events: %w", err)
	}
	return count, nil
}

func scanEvent(scanner rowScanner) (task.Event, error) {
	var event task.Event
	var payload string
	var hash sql.NullString
	var payloadBytes int64
	var redacted, truncated int
	var createdAt int64
	err := scanner.Scan(
		&event.ID, &event.RunID, &event.Seq, &event.Type, &payload, &hash,
		&payloadBytes, &redacted, &truncated, &createdAt,
	)
	if err != nil {
		return task.Event{}, err
	}
	event.Payload = []byte(payload)
	if hash.Valid {
		event.PayloadSHA256 = hash.String
	}
	event.PayloadBytes = int(payloadBytes)
	event.Redacted = redacted != 0
	event.Truncated = truncated != 0
	event.CreatedAt = timeFromMilli(createdAt)
	return event, nil
}
