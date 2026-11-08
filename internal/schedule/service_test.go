package schedule

import (
	"context"
	"errors"
	"sort"
	"testing"
	"time"
)

func TestServiceCreateComputesNextAndValidates(t *testing.T) {
	store := newFakeStore()
	service := NewService(store)
	now := time.Date(2026, 11, 9, 8, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	service.newID = func(prefix string) string { return prefix + "-fixed" }

	value, err := service.Create(context.Background(), CreateInput{
		TaskID: "task-1", Name: "Daily", Prompt: "run", WorkspaceID: "workspace-1",
		Frequency: FrequencyDaily, Time: "09:00", Timezone: "UTC", Enabled: true, CatchUp: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if value.ID != "schedule-fixed" || value.NextRunAt == nil || !value.NextRunAt.Equal(time.Date(2026, 11, 9, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("unexpected created schedule: %#v", value)
	}

	for _, input := range []CreateInput{
		{TaskID: "task-1", Name: "missing prompt", WorkspaceID: "workspace-1", Frequency: FrequencyDaily, Time: "09:00", Enabled: true},
		{TaskID: "task-1", Name: "bad clock", Prompt: "run", WorkspaceID: "workspace-1", Frequency: FrequencyDaily, Time: "24:00", Enabled: true},
		{TaskID: "task-1", Name: "bad model", Prompt: "run", WorkspaceID: "workspace-1", ModelProvider: "openai", Frequency: FrequencyDaily, Time: "09:00", Enabled: true},
		{TaskID: "task-1", Name: "bad weekly", Prompt: "run", WorkspaceID: "workspace-1", Frequency: FrequencyWeekly, Time: "09:00", Weekday: 7, Enabled: true},
		{TaskID: "task-1", Name: "no next", Prompt: "run", WorkspaceID: "workspace-1", Frequency: FrequencyOnce, Enabled: true},
	} {
		if _, err := service.Create(context.Background(), input); !errors.Is(err, ErrInvalid) {
			t.Fatalf("Create(%q) error = %v, want %v", input.Name, err, ErrInvalid)
		}
	}
}

func TestServiceSetRuntimeAndDue(t *testing.T) {
	store := newFakeStore()
	service := NewService(store)
	now := time.Date(2026, 11, 9, 8, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	service.newID = func(prefix string) string { return prefix + "-fixed" }
	value, err := service.Create(context.Background(), CreateInput{
		TaskID: "task-1", Name: "Daily", Prompt: "run", WorkspaceID: "workspace-1",
		Frequency: FrequencyDaily, Time: "09:00", Timezone: "UTC", Enabled: true, CatchUp: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	due, err := service.Due(context.Background(), now.Add(2*time.Hour), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 1 || due[0].ID != value.ID {
		t.Fatalf("due = %#v", due)
	}
	updated, err := service.SetRuntime(context.Background(), value.ID, now, StatusFailed, "thread-1", "boom")
	if err != nil {
		t.Fatal(err)
	}
	if updated.LastStatus != StatusFailed || updated.LastThreadID != "thread-1" || updated.LastError != "boom" || updated.LastRunAt == nil {
		t.Fatalf("runtime update lost fields: %#v", updated)
	}
}

type fakeStore struct {
	values map[string]Schedule
}

func newFakeStore() *fakeStore {
	return &fakeStore{values: map[string]Schedule{}}
}

func (store *fakeStore) CreateSchedule(_ context.Context, value Schedule) error {
	if _, exists := store.values[value.ID]; exists {
		return errors.New("duplicate")
	}
	store.values[value.ID] = value
	return nil
}

func (store *fakeStore) GetSchedule(_ context.Context, id string) (Schedule, error) {
	value, ok := store.values[id]
	if !ok {
		return Schedule{}, ErrNotFound
	}
	return value, nil
}

func (store *fakeStore) ListSchedules(context.Context) ([]Schedule, error) {
	result := make([]Schedule, 0, len(store.values))
	for _, value := range store.values {
		result = append(result, value)
	}
	sort.Slice(result, func(left, right int) bool {
		return result[left].UpdatedAt.After(result[right].UpdatedAt)
	})
	return result, nil
}

func (store *fakeStore) ListDueSchedules(_ context.Context, now time.Time, limit int) ([]Schedule, error) {
	result := make([]Schedule, 0, len(store.values))
	for _, value := range store.values {
		if value.Enabled && value.NextRunAt != nil && !value.NextRunAt.After(now) {
			result = append(result, value)
		}
	}
	sort.Slice(result, func(left, right int) bool {
		return result[left].NextRunAt.Before(*result[right].NextRunAt)
	})
	if limit > 0 && len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func (store *fakeStore) UpdateSchedule(_ context.Context, value Schedule) error {
	if _, exists := store.values[value.ID]; !exists {
		return ErrNotFound
	}
	store.values[value.ID] = value
	return nil
}

func (store *fakeStore) DeleteSchedule(_ context.Context, id string) error {
	if _, exists := store.values[id]; !exists {
		return ErrNotFound
	}
	delete(store.values, id)
	return nil
}
