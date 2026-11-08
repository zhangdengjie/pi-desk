package appservice

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"sync"

	"pi-desk/internal/eventbus"
	"pi-desk/internal/piruntime"
	"pi-desk/internal/storage/sqlite"
	"pi-desk/internal/task"
	"pi-desk/internal/workspace"
)

// HarnessEnv enables the R1a data plane. It is deliberately opt-in so the
// existing chat path remains byte-identical when the environment is absent.
const HarnessEnv = "PI_DESK_HARNESS"

func HarnessEnabled() bool {
	return os.Getenv(HarnessEnv) == "1"
}

// Harness owns the SQLite store and the event tap for one application process.
// R1a taps the local Supervisor only. Remote Pi sessions use a separate broker
// path; feeding them into the same tap is an R2 item (see ADR-002).
type Harness struct {
	store     *sqlite.Store
	tap       *eventbus.Tap
	closeOnce sync.Once
}

func StartHarness(ctx context.Context, dataDir string, catalog *workspace.Catalog) (*Harness, error) {
	if !HarnessEnabled() {
		return nil, nil
	}
	store, err := sqlite.Open(filepath.Join(dataDir, "pi-desk.db"))
	if err != nil {
		return nil, err
	}
	service := task.NewService(store)
	report, importErr := task.ImportLegacy(ctx, service, catalogLegacySource{catalog: catalog}, false)
	if importErr != nil {
		log.Printf("harness: import legacy state: %v", importErr)
	} else {
		log.Printf("harness: imported %d/%d legacy threads", report.Created, report.Scanned)
	}
	tap := eventbus.NewTap(service, store)
	tap.Start(ctx)
	return &Harness{store: store, tap: tap}, nil
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
