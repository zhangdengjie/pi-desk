package schedule

import (
	"context"
	"fmt"
	"strings"
	"time"

	"pi-desk/internal/task"
)

type Service struct {
	store Store
	now   func() time.Time
	newID func(string) string
}

func NewService(store Store) *Service {
	return &Service{store: store, now: time.Now, newID: task.NewID}
}

func (service *Service) Create(ctx context.Context, input CreateInput) (Schedule, error) {
	value := Schedule{
		TaskID:        strings.TrimSpace(input.TaskID),
		Name:          strings.TrimSpace(input.Name),
		Prompt:        strings.TrimSpace(input.Prompt),
		WorkspaceID:   strings.TrimSpace(input.WorkspaceID),
		ModelProvider: strings.TrimSpace(input.ModelProvider),
		ModelID:       strings.TrimSpace(input.ModelID),
		ModelName:     strings.TrimSpace(input.ModelName),
		ThinkingLevel: strings.TrimSpace(input.ThinkingLevel),
		Frequency:     input.Frequency,
		Time:          strings.TrimSpace(input.Time),
		Weekday:       input.Weekday,
		RunAt:         utcPointer(input.RunAt),
		Timezone:      strings.TrimSpace(input.Timezone),
		Enabled:       input.Enabled,
		CatchUp:       input.CatchUp,
		LastThreadID:  strings.TrimSpace(input.LastThreadID),
	}
	if value.Timezone == "" {
		value.Timezone = "local"
	}
	now := service.now().UTC()
	value.ID = service.newID("schedule")
	value.CreatedAt = now
	value.UpdatedAt = now
	if input.NextRunAt != nil {
		value.NextRunAt = utcPointer(input.NextRunAt)
	} else if next, ok := Next(value, now); ok {
		next = next.UTC()
		value.NextRunAt = &next
	}
	if err := validate(value); err != nil {
		return Schedule{}, err
	}
	if err := service.store.CreateSchedule(ctx, value); err != nil {
		return Schedule{}, err
	}
	return value, nil
}

// Import stores a schedule with its legacy identity and timestamps. It is used
// only by the one-time state.json migration, where preserving the id makes the
// import idempotent across restarts.
func (service *Service) Import(ctx context.Context, value Schedule) (Schedule, error) {
	value.ID = strings.TrimSpace(value.ID)
	if value.ID == "" {
		return Schedule{}, fmt.Errorf("%w: schedule id is required", ErrInvalid)
	}
	if value.Timezone == "" {
		value.Timezone = "local"
	}
	now := service.now().UTC()
	if value.CreatedAt.IsZero() {
		value.CreatedAt = now
	}
	if value.UpdatedAt.IsZero() {
		value.UpdatedAt = value.CreatedAt
	}
	if err := validate(value); err != nil {
		return Schedule{}, err
	}
	if err := service.store.CreateSchedule(ctx, value); err != nil {
		return Schedule{}, err
	}
	return value, nil
}

func (service *Service) Get(ctx context.Context, id string) (Schedule, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return Schedule{}, fmt.Errorf("%w: schedule id is required", ErrInvalid)
	}
	return service.store.GetSchedule(ctx, id)
}

func (service *Service) List(ctx context.Context) ([]Schedule, error) {
	return service.store.ListSchedules(ctx)
}

func (service *Service) Due(ctx context.Context, now time.Time, limit int) ([]Schedule, error) {
	return service.store.ListDueSchedules(ctx, now, limit)
}

func (service *Service) Update(ctx context.Context, value Schedule) (Schedule, error) {
	value.ID = strings.TrimSpace(value.ID)
	if value.ID == "" {
		return Schedule{}, fmt.Errorf("%w: schedule id is required", ErrInvalid)
	}
	value.UpdatedAt = service.now().UTC()
	if err := validate(value); err != nil {
		return Schedule{}, err
	}
	if err := service.store.UpdateSchedule(ctx, value); err != nil {
		return Schedule{}, err
	}
	return value, nil
}

func (service *Service) Delete(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("%w: schedule id is required", ErrInvalid)
	}
	return service.store.DeleteSchedule(ctx, id)
}

func (service *Service) SetRuntime(ctx context.Context, id string, at time.Time, status RunStatus, threadID, errorMessage string) (Schedule, error) {
	value, err := service.Get(ctx, id)
	if err != nil {
		return Schedule{}, err
	}
	value.LastRunAt = utcPointer(&at)
	value.LastStatus = status
	value.LastThreadID = strings.TrimSpace(threadID)
	value.LastError = strings.TrimSpace(errorMessage)
	return service.Update(ctx, value)
}

func validate(value Schedule) error {
	if strings.TrimSpace(value.TaskID) == "" {
		return fmt.Errorf("%w: task id is required", ErrInvalid)
	}
	if strings.TrimSpace(value.Name) == "" {
		return fmt.Errorf("%w: name is required", ErrInvalid)
	}
	if strings.TrimSpace(value.Prompt) == "" {
		return fmt.Errorf("%w: prompt is required", ErrInvalid)
	}
	if strings.TrimSpace(value.WorkspaceID) == "" {
		return fmt.Errorf("%w: workspace id is required", ErrInvalid)
	}
	if (value.ModelProvider == "") != (value.ModelID == "") {
		return fmt.Errorf("%w: model provider and id must be set together", ErrInvalid)
	}
	switch value.Frequency {
	case FrequencyOnce:
		if value.RunAt == nil {
			return fmt.Errorf("%w: once schedule needs runAt", ErrInvalid)
		}
	case FrequencyHourly, FrequencyDaily, FrequencyWeekdays:
		if _, _, ok := parseClock(value.Time); !ok {
			return fmt.Errorf("%w: %s schedule needs a valid HH:MM time", ErrInvalid, value.Frequency)
		}
	case FrequencyWeekly:
		if _, _, ok := parseClock(value.Time); !ok {
			return fmt.Errorf("%w: weekly schedule needs a valid HH:MM time", ErrInvalid)
		}
		if value.Weekday < 0 || value.Weekday > 6 {
			return fmt.Errorf("%w: weekly schedule weekday must be 0..6", ErrInvalid)
		}
	default:
		return fmt.Errorf("%w: unknown frequency %q", ErrInvalid, value.Frequency)
	}
	if value.Enabled && value.NextRunAt == nil {
		return fmt.Errorf("%w: enabled schedule needs nextRunAt", ErrInvalid)
	}
	return nil
}

func utcPointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	normalized := value.UTC()
	return &normalized
}
