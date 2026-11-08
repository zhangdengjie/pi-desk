// Package schedule owns recurring Task triggers. It stores timing and display
// metadata; the actual Run start is performed by the application service.
package schedule

import (
	"context"
	"errors"
	"time"
)

type Frequency string

const (
	FrequencyOnce     Frequency = "once"
	FrequencyHourly   Frequency = "hourly"
	FrequencyDaily    Frequency = "daily"
	FrequencyWeekdays Frequency = "weekdays"
	FrequencyWeekly   Frequency = "weekly"
)

type RunStatus string

const (
	StatusStarted   RunStatus = "started"
	StatusCompleted RunStatus = "completed"
	StatusFailed    RunStatus = "failed"
	StatusCancelled RunStatus = "cancelled"
	StatusMissed    RunStatus = "missed"
	StatusSkipped   RunStatus = "skipped"
)

var (
	ErrNotFound = errors.New("schedule not found")
	ErrInvalid  = errors.New("schedule is invalid")
)

// Schedule is one recurring trigger. A Task owns the durable intent and the Pi
// session; the Schedule only decides when the next Run starts.
type Schedule struct {
	ID            string
	TaskID        string
	Name          string
	Prompt        string
	WorkspaceID   string
	ModelProvider string
	ModelID       string
	ModelName     string
	ThinkingLevel string
	Frequency     Frequency
	Time          string
	Weekday       int
	RunAt         *time.Time
	Timezone      string
	Enabled       bool
	CatchUp       bool
	NextRunAt     *time.Time
	LastRunAt     *time.Time
	LastCatchUpAt *time.Time
	LastStatus    RunStatus
	LastError     string
	LastThreadID  string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type CreateInput struct {
	TaskID        string
	Name          string
	Prompt        string
	WorkspaceID   string
	ModelProvider string
	ModelID       string
	ModelName     string
	ThinkingLevel string
	Frequency     Frequency
	Time          string
	Weekday       int
	RunAt         *time.Time
	NextRunAt     *time.Time
	Timezone      string
	Enabled       bool
	CatchUp       bool
	LastThreadID  string
}

type Store interface {
	CreateSchedule(ctx context.Context, value Schedule) error
	GetSchedule(ctx context.Context, id string) (Schedule, error)
	ListSchedules(ctx context.Context) ([]Schedule, error)
	ListDueSchedules(ctx context.Context, now time.Time, limit int) ([]Schedule, error)
	UpdateSchedule(ctx context.Context, value Schedule) error
	DeleteSchedule(ctx context.Context, id string) error
}
