package task

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

// Status is shared by Task and Run state machines.
type Status string

const (
	StatusCreated         Status = "created"
	StatusQueued          Status = "queued"
	StatusRunning         Status = "running"
	StatusWaitingApproval Status = "waiting_approval"
	StatusWaitingInput    Status = "waiting_input"
	StatusPaused          Status = "paused"
	StatusCompleted       Status = "completed"
	StatusFailed          Status = "failed"
	StatusCancelled       Status = "cancelled"
)

type Origin string

const (
	OriginChat      Origin = "chat"
	OriginLegacy    Origin = "legacy"
	OriginScheduled Origin = "scheduled"
	OriginManual    Origin = "manual"
)

// Task is the durable intent. A Task can have many Runs.
type Task struct {
	ID             string
	Title          string
	Description    string
	Status         Status
	WorkspaceID    string
	AgentProfileID string
	Origin         Origin
	Priority       int
	LegacyThreadID string
	Metadata       string
	CreatedAt      time.Time
	UpdatedAt      time.Time
	CompletedAt    *time.Time
	ArchivedAt     *time.Time
}

// Run is one execution attempt of a Task.
type Run struct {
	ID            string
	TaskID        string
	Runtime       string
	SessionPath   string
	ModelProvider string
	ModelID       string
	Status        Status
	Attempt       int
	Generation    uint64
	Error         string
	CreatedAt     time.Time
	StartedAt     *time.Time
	FinishedAt    *time.Time
}

// Event is the persisted terminal/intermediate event for a Run.
type Event struct {
	ID            string
	RunID         string
	Seq           uint64
	Type          string
	Payload       json.RawMessage
	PayloadSHA256 string
	PayloadBytes  int
	Redacted      bool
	Truncated     bool
	CreatedAt     time.Time
}

// Usage is the per-Run aggregate (one row per Run).
type Usage struct {
	ID               string
	RunID            string
	Provider         string
	Model            string
	InputTokens      int64
	OutputTokens     int64
	CacheReadTokens  int64
	CacheWriteTokens int64
	EstimatedCost    float64
	CreatedAt        time.Time
}

var (
	ErrNotFound          = errors.New("task not found")
	ErrInvalidTransition = errors.New("invalid state transition")
	ErrDuplicate         = errors.New("duplicate record")
)

// Store is the persistence contract. internal/storage/sqlite implements it.
type Store interface {
	CreateTask(ctx context.Context, task Task) error
	GetTask(ctx context.Context, id string) (Task, error)
	FindTaskByLegacyThreadID(ctx context.Context, threadID string) (Task, error)
	ListTasks(ctx context.Context, limit int) ([]Task, error)
	ListArchivedTasks(ctx context.Context, limit int) ([]Task, error)
	SetTaskArchived(ctx context.Context, id string, archivedAt *time.Time, updatedAt time.Time) error
	UpdateTaskStatus(ctx context.Context, id string, status Status, updatedAt time.Time, completedAt *time.Time) error

	CreateRun(ctx context.Context, run Run) error
	GetRun(ctx context.Context, id string) (Run, error)
	ListRuns(ctx context.Context, taskID string) ([]Run, error)
	ListActiveRuns(ctx context.Context) ([]Run, error)
	UpdateRun(ctx context.Context, run Run) error
	MaxEventSeq(ctx context.Context, runID string) (uint64, error)

	AppendEvent(ctx context.Context, event Event) error
	ListEvents(ctx context.Context, runID string, afterSeq uint64) ([]Event, error)
	CountEvents(ctx context.Context, runID string) (int, error)

	UpsertUsage(ctx context.Context, usage Usage) error
	GetUsage(ctx context.Context, runID string) (Usage, error)
}

// NewID returns a time-sortable, process-unique identifier. It deliberately
// avoids a new dependency; the random suffix makes collisions negligible.
func NewID(prefix string) string {
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return prefix + "_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return prefix + "_" + strconv.FormatInt(time.Now().UnixMilli(), 36) + "_" + hex.EncodeToString(suffix[:])
}
