package appservice

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"pi-desk/internal/eventbus"
	"pi-desk/internal/piruntime"
	"pi-desk/internal/storage/sqlite"
	"pi-desk/internal/task"
	"pi-desk/internal/workspace"
)

// HarnessEnv controls the R1a data plane. It is on by default after the R1b
// verification; set it to 0/false/off for a clean rollback to the chat-only path.
const HarnessEnv = "PI_DESK_HARNESS"

func HarnessEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(HarnessEnv))) {
	case "0", "false", "off":
		return false
	default:
		return true
	}
}

// Harness owns the SQLite store and the event tap for one application process.
// R1a taps the local Supervisor only. Remote Pi sessions use a separate broker
// path; feeding them into the same tap is an R2 item (see ADR-002).
type Harness struct {
	store     *sqlite.Store
	tap       *eventbus.Tap
	service   *task.Service
	closeOnce sync.Once
}

func StartHarness(ctx context.Context, dataDir string, catalog *workspace.Catalog) (*Harness, error) {
	if !HarnessEnabled() {
		return nil, nil
	}
	dbPath := filepath.Join(dataDir, "pi-desk.db")
	_, statErr := os.Stat(dbPath)
	store, err := sqlite.Open(dbPath)
	if err != nil {
		return nil, err
	}
	if errors.Is(statErr, os.ErrNotExist) {
		if err := backupLegacyState(dataDir); err != nil {
			log.Printf("harness: backup state.json: %v", err)
		}
	}
	service := task.NewService(store)
	report, importErr := task.ImportLegacy(ctx, service, catalogLegacySource{catalog: catalog}, false)
	if importErr != nil {
		log.Printf("harness: import legacy state: %v", importErr)
	} else {
		log.Printf("harness: imported %d/%d legacy threads", report.Created, report.Scanned)
	}
	if repaired, repairErr := service.ReconcileInterruptedRuns(ctx, "interrupted before Pi Desk restarted"); repairErr != nil {
		log.Printf("harness: reconcile interrupted runs: %v", repairErr)
	} else if repaired > 0 {
		log.Printf("harness: marked %d interrupted run(s) failed", repaired)
	}
	tap := eventbus.NewTap(service, store)
	tap.Start(ctx)
	return &Harness{store: store, tap: tap, service: service}, nil
}

func (harness *Harness) SetEmitter(emitter func(eventbus.Event)) {
	harness.tap.SetEmitter(emitter)
}

func (harness *Harness) Handle(event piruntime.SessionEvent) {
	harness.tap.Handle(event)
}

func (harness *Harness) Close() {
	harness.closeOnce.Do(func() {
		harness.tap.Close()
		if err := harness.store.Close(); err != nil {
			log.Printf("harness: close sqlite: %v", err)
		}
	})
}

type catalogLegacySource struct {
	catalog *workspace.Catalog
}

// backupLegacyState copies state.json beside the DB before the first import.
// Import itself is read-only, but the backup makes a failed migration
// recoverable without asking the user to find the original file.
func backupLegacyState(dataDir string) error {
	source := filepath.Join(dataDir, "state.json")
	body, err := os.ReadFile(source)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	backupDir := filepath.Join(dataDir, "backup")
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		return err
	}
	name := "state-" + time.Now().UTC().Format("20060102T150405Z") + ".json"
	return os.WriteFile(filepath.Join(backupDir, name), body, 0o600)
}

func (source catalogLegacySource) LegacyThreads() ([]task.LegacyThread, error) {
	desktop, err := source.catalog.Desktop()
	if err != nil {
		return nil, err
	}
	result := make([]task.LegacyThread, 0, len(desktop.Threads))
	for _, thread := range desktop.Threads {
		result = append(result, task.LegacyThread{
			ID:            thread.ID,
			Title:         thread.Title,
			WorkspaceID:   thread.WorkspaceID,
			WorkspacePath: thread.WorkspacePath,
			Trust:         thread.Trust,
			Status:        thread.Status,
			SessionPath:   thread.SessionPath,
			CreatedAt:     thread.CreatedAt,
			UpdatedAt:     thread.UpdatedAt,
		})
	}
	return result, nil
}
