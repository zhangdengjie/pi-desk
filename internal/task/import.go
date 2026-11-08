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
	Runs    int
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
		existing, err := service.store.FindTaskByLegacyThreadID(ctx, threadID)
		if err == nil {
			if thread.SessionPath != "" {
				runs, listErr := service.store.ListRuns(ctx, existing.ID)
				if listErr != nil {
					return report, listErr
				}
				if len(runs) == 0 {
					report.Runs++
					if !dryRun {
						if err := createLegacyRun(ctx, service, existing.ID, thread); err != nil {
							return report, err
						}
					}
				}
			}
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
		created, err := service.CreateTask(ctx, CreateTaskInput{
			Title:          title,
			WorkspaceID:    thread.WorkspaceID,
			Origin:         OriginLegacy,
			LegacyThreadID: threadID,
			Metadata:       metadata,
		})
		if err != nil {
			return report, err
		}
		if thread.SessionPath != "" {
			report.Runs++
			if !dryRun {
				if err := createLegacyRun(ctx, service, created.ID, thread); err != nil {
					return report, err
				}
			}
		}
	}
	return report, nil
}

func createLegacyRun(ctx context.Context, service *Service, taskID string, thread LegacyThread) error {
	now := service.now().UTC()
	finished := now
	status := StatusCompleted
	message := ""
	if thread.Status == "running" || thread.Status == "starting" || thread.Status == "attention" {
		status = StatusFailed
		message = "imported while " + thread.Status
	}
	return service.store.CreateRun(ctx, Run{
		ID: service.newID("run"), TaskID: taskID, Runtime: "pi",
		SessionPath: thread.SessionPath, Status: status, Attempt: 1,
		Error: message, CreatedAt: now, FinishedAt: &finished,
	})
}
