package schedule

import (
	"testing"
	"time"
)

func TestNextMirrorsFrontendRules(t *testing.T) {
	reference := time.Date(2026, 11, 9, 10, 10, 0, 0, time.UTC)
	cases := []struct {
		name  string
		value Schedule
		want  time.Time
		ok    bool
	}{
		{
			name:  "once future",
			value: Schedule{Frequency: FrequencyOnce, RunAt: timePointer(time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)), Timezone: "UTC"},
			want:  time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC),
			ok:    true,
		},
		{
			name:  "once past",
			value: Schedule{Frequency: FrequencyOnce, RunAt: timePointer(time.Date(2026, 11, 9, 9, 0, 0, 0, time.UTC)), Timezone: "UTC"},
			ok:    false,
		},
		{
			name:  "hourly later in hour",
			value: Schedule{Frequency: FrequencyHourly, Time: "10:15", Timezone: "UTC"},
			want:  time.Date(2026, 11, 9, 10, 15, 0, 0, time.UTC),
			ok:    true,
		},
		{
			name:  "hourly next hour",
			value: Schedule{Frequency: FrequencyHourly, Time: "11:05", Timezone: "UTC"},
			want:  time.Date(2026, 11, 9, 11, 5, 0, 0, time.UTC),
			ok:    true,
		},
		{
			name:  "daily later today",
			value: Schedule{Frequency: FrequencyDaily, Time: "18:30", Timezone: "UTC"},
			want:  time.Date(2026, 11, 9, 18, 30, 0, 0, time.UTC),
			ok:    true,
		},
		{
			name:  "daily tomorrow",
			value: Schedule{Frequency: FrequencyDaily, Time: "08:00", Timezone: "UTC"},
			want:  time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC),
			ok:    true,
		},
		{
			name:  "weekdays skip weekend",
			value: Schedule{Frequency: FrequencyWeekdays, Time: "09:00", Timezone: "UTC"},
			want:  time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC),
			ok:    true,
		},
		{
			name:  "weekly same day before clock",
			value: Schedule{Frequency: FrequencyWeekly, Time: "12:00", Weekday: int(time.Monday), Timezone: "UTC"},
			want:  time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC),
			ok:    true,
		},
		{
			name:  "weekly next week",
			value: Schedule{Frequency: FrequencyWeekly, Time: "09:00", Weekday: int(time.Monday), Timezone: "UTC"},
			want:  time.Date(2026, 11, 16, 9, 0, 0, 0, time.UTC),
			ok:    true,
		},
		{
			name:  "invalid clock",
			value: Schedule{Frequency: FrequencyDaily, Time: "25:00", Timezone: "UTC"},
			ok:    false,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, ok := Next(testCase.value, reference)
			if ok != testCase.ok {
				t.Fatalf("Next ok = %v, want %v (got %v)", ok, testCase.ok, got)
			}
			if ok && !got.Equal(testCase.want) {
				t.Fatalf("Next = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestNextUsesScheduleTimezone(t *testing.T) {
	reference := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	value := Schedule{Frequency: FrequencyDaily, Time: "09:00", Timezone: "America/New_York"}
	next, ok := Next(value, reference)
	if !ok {
		t.Fatal("Next returned no occurrence")
	}
	want := time.Date(2026, 11, 9, 14, 0, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Fatalf("Next = %v, want %v", next, want)
	}
}

func timePointer(value time.Time) *time.Time { return &value }
