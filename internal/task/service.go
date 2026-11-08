package task

import (
	"context"
	"errors"
	"strings"
	"time"
)

// Service owns Task/Run lifecycle rules. Persistence is delegated to Store.
type Service struct {
	store Store
	now   func() time.Time
	newID func(string) string
}

func NewService(store Store) *Service {
	return &Service{store: store, now: time.Now, newID: NewID}
}

type CreateTaskInput struct {
	Title          string
	Description    string
	WorkspaceID    string
	AgentProfileID string
	Origin         Origin
	Priority       int
	LegacyThreadID string
	Metadata       string
}

func (s *Service) CreateTask(ctx context.Context, input CreateTaskInput) (Task, error) {
	title := strings.TrimSpace(input.Title)
	if title == "" {
		return Task{}, errors.New("task title is required")
	}
	origin := input.Origin
	if origin == "" {
		origin = OriginChat
	}
	metadata := strings.TrimSpace(input.Metadata)
	if metadata == "" {
		metadata = "{}"
	}
	now := s.now().UTC()
	task := Task{
		ID:             s.newID("task"),
		Title:          title,
		Description:    input.Description,
		Status:         StatusCreated,
		WorkspaceID:    strings.TrimSpace(input.WorkspaceID),
		AgentProfileID: strings.TrimSpace(input.AgentProfileID),
		Origin:         origin,
		Priority:       input.Priority,
		LegacyThreadID: strings.TrimSpace(input.LegacyThreadID),
		Metadata:       metadata,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := s.store.CreateTask(ctx, task); err != nil {
		return Task{}, err
	}
	return task, nil
}

func (s *Service) GetTask(ctx context.Context, id string) (Task, error) {
	return s.store.GetTask(ctx, id)
}

func (s *Service) ListTasks(ctx context.Context, limit int) ([]Task, error) {
	return s.store.ListTasks(ctx, limit)
}

func (s *Service) FindTaskByLegacyThreadID(ctx context.Context, threadID string) (Task, error) {
	return s.store.FindTaskByLegacyThreadID(ctx, threadID)
}

func (s *Service) CreateRun(ctx context.Context, taskID, runtimeID string) (Run, error) {
	task, err := s.store.GetTask(ctx, taskID)
	if err != nil {
		return Run{}, err
	}
	if IsTerminal(task.Status) {
		return Run{}, ErrInvalidTransition
	}
	now := s.now().UTC()
	run := Run{
		ID:        s.newID("run"),
		TaskID:    task.ID,
		Runtime:   runtimeID,
		Status:    StatusQueued,
		Attempt:   1,
		CreatedAt: now,
	}
	if err := s.store.CreateRun(ctx, run); err != nil {
		return Run{}, err
	}
	return run, nil
}

func (s *Service) StartRun(ctx context.Context, runID string) (Run, error) {
	run, err := s.store.GetRun(ctx, runID)
	if err != nil {
		return Run{}, err
	}
	if !CanTransitionRun(run.Status, StatusRunning) {
		return Run{}, ErrInvalidTransition
	}
	now := s.now().UTC()
	run.Status = StatusRunning
	run.StartedAt = &now
	if err := s.store.UpdateRun(ctx, run); err != nil {
		return Run{}, err
	}
	if task, err := s.store.GetTask(ctx, run.TaskID); err == nil && CanTransitionTask(task.Status, StatusRunning) {
		if err := s.store.UpdateTaskStatus(ctx, task.ID, StatusRunning, now, nil); err != nil {
			return Run{}, err
		}
	}
	return run, nil
}

// FinishRun moves a Run to a terminal state. Task completion is intentionally
// left to R1b: a chat Task can accumulate several Runs over time.
func (s *Service) FinishRun(ctx context.Context, runID string, status Status, message string) (Run, error) {
	if !IsTerminal(status) {
		return Run{}, ErrInvalidTransition
	}
	run, err := s.store.GetRun(ctx, runID)
	if err != nil {
		return Run{}, err
	}
	if !CanTransitionRun(run.Status, status) {
		return Run{}, ErrInvalidTransition
	}
	now := s.now().UTC()
	run.Status = status
	run.Error = message
	run.FinishedAt = &now
	if err := s.store.UpdateRun(ctx, run); err != nil {
		return Run{}, err
	}
	return run, nil
}

func (s *Service) TransitionTask(ctx context.Context, id string, status Status) (Task, error) {
	task, err := s.store.GetTask(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if !CanTransitionTask(task.Status, status) {
		return Task{}, ErrInvalidTransition
	}
	now := s.now().UTC()
	var completedAt *time.Time
	if status == StatusCompleted {
		completedAt = &now
	}
	if err := s.store.UpdateTaskStatus(ctx, id, status, now, completedAt); err != nil {
		return Task{}, err
	}
	task.Status = status
	task.UpdatedAt = now
	task.CompletedAt = completedAt
	return task, nil
}

// EnsureChatTask maps a thread to a Task. Existing legacy threads and new chat
// threads share the same lookup key (legacy_thread_id is a misnomer kept for
// the current schema; it is simply the thread identity).
func (s *Service) EnsureChatTask(ctx context.Context, threadID, title string) (Task, error) {
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return Task{}, errors.New("thread id is required")
	}
	task, err := s.store.FindTaskByLegacyThreadID(ctx, threadID)
	if err == nil {
		return task, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return Task{}, err
	}
	if strings.TrimSpace(title) == "" {
		title = threadID
	}
	return s.CreateTask(ctx, CreateTaskInput{
		Title:          title,
		Origin:         OriginChat,
		LegacyThreadID: threadID,
	})
}

// StartRunForThread returns the active Run for a thread, or creates and starts
// one. This is the R1a bridge from the existing thread-centric event stream to
// Task/Run records.
func (s *Service) StartRunForThread(ctx context.Context, threadID, title, runtimeID string) (Task, Run, error) {
	task, err := s.EnsureChatTask(ctx, threadID, title)
	if err != nil {
		return Task{}, Run{}, err
	}
	runs, err := s.store.ListRuns(ctx, task.ID)
	if err != nil {
		return Task{}, Run{}, err
	}
	for _, run := range runs {
		if run.Status == StatusQueued || run.Status == StatusRunning ||
			run.Status == StatusWaitingApproval || run.Status == StatusWaitingInput {
			return task, run, nil
		}
	}
	run, err := s.CreateRun(ctx, task.ID, runtimeID)
	if err != nil {
		return Task{}, Run{}, err
	}
	run, err = s.StartRun(ctx, run.ID)
	if err != nil {
		return Task{}, Run{}, err
	}
	return task, run, nil
}

func (s *Service) GetRun(ctx context.Context, id string) (Run, error) {
	return s.store.GetRun(ctx, id)
}

func (s *Service) ListRuns(ctx context.Context, taskID string) ([]Run, error) {
	return s.store.ListRuns(ctx, taskID)
}
