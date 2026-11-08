package task

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// LegacyThread is the adapter shape for a state.json thread. It deliberately
// lives in this package so the importer does not depend on internal/workspace.
type LegacyThread struct {
	ID            string
	Title         string
	WorkspaceID   string
	WorkspacePath string
	Trust         string
	Status        string
	SessionPath   string
	CreatedAt     string
	UpdatedAt     string
}

type LegacySource interface {
	LegacyThreads() ([]LegacyThread, error)
}

type ImportReport struct {
	Scanned int
	Created int
	Skipped int
	DryRun  bool
}

// ImportLegacy creates one Task per existing thread. It is idempotent by
// legacy_thread_id and never copies message bodies.
func ImportLegacy(ctx context.Context, service *Service, source LegacySource, dryRun bool) (ImportReport, error) {
	report := ImportReport{DryRun: dryRun}
	threads, err := source.LegacyThreads()
	if err != nil {
		return report, err
	}
	for _, thread := range threads {
		threadID := strings.TrimSpace(thread.ID)
		if threadID == "" {
			continue
		}
		report.Scanned++
		_, err := service.store.FindTaskByLegacyThreadID(ctx, threadID)
		if err == nil {
			report.Skipped++
			continue
		}
		if !errors.Is(err, ErrNotFound) {
			return report, err
		}
		report.Created++
		if dryRun {
			continue
		}
		metadata := "{}"
		if thread.SessionPath != "" {
			if encoded, marshalErr := json.Marshal(map[string]string{"sessionPath": thread.SessionPath}); marshalErr == nil {
				metadata = string(encoded)
			}
		}
		title := strings.TrimSpace(thread.Title)
		if title == "" {
			title = threadID
		}
		if _, err := service.CreateTask(ctx, CreateTaskInput{
			Title:          title,
			WorkspaceID:    thread.WorkspaceID,
			Origin:         OriginLegacy,
			LegacyThreadID: threadID,
			Metadata:       metadata,
		}); err != nil {
			return report, err
		}
	}
	return report, nil
}
