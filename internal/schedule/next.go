package schedule

import (
	"strings"
	"time"
)

// Location resolves the schedule's timezone. "local" and an empty value use
// the process timezone; an unknown IANA name falls back to local so a typo
// cannot stop the scheduler.
func Location(name string) *time.Location {
	name = strings.TrimSpace(name)
	if name == "" || strings.EqualFold(name, "local") {
		return time.Local
	}
	location, err := time.LoadLocation(name)
	if err != nil {
		return time.Local
	}
	return location
}

// Next returns the first occurrence strictly after the reference time.
// It mirrors frontend/src/utils/scheduledTasks.ts:nextScheduledRun, including
// the weekday/weekend skip and the "today's clock already passed" rules.
func Next(value Schedule, after time.Time) (time.Time, bool) {
	location := Location(value.Timezone)
	after = after.In(location)
	switch value.Frequency {
	case FrequencyOnce:
		if value.RunAt == nil {
			return time.Time{}, false
		}
		runAt := value.RunAt.In(location)
		if runAt.After(after) {
			return runAt, true
		}
		return time.Time{}, false
	case FrequencyHourly, FrequencyDaily, FrequencyWeekdays, FrequencyWeekly:
		hour, minute, ok := parseClock(value.Time)
		if !ok {
			return time.Time{}, false
		}
		candidate := time.Date(after.Year(), after.Month(), after.Day(), after.Hour(), minute, 0, 0, location)
		if value.Frequency == FrequencyHourly {
			if !candidate.After(after) {
				candidate = candidate.Add(time.Hour)
			}
			return candidate, true
		}
		candidate = time.Date(after.Year(), after.Month(), after.Day(), hour, minute, 0, 0, location)
		if !candidate.After(after) {
			candidate = candidate.AddDate(0, 0, 1)
		}
		switch value.Frequency {
		case FrequencyDaily:
			return candidate, true
		case FrequencyWeekdays:
			for candidate.Weekday() == time.Saturday || candidate.Weekday() == time.Sunday {
				candidate = candidate.AddDate(0, 0, 1)
			}
			return candidate, true
		case FrequencyWeekly:
			weekday := value.Weekday
			if weekday < 0 || weekday > 6 {
				weekday = 1
			}
			days := (weekday - int(candidate.Weekday()) + 7) % 7
			candidate = candidate.AddDate(0, 0, days)
			if !candidate.After(after) {
				candidate = candidate.AddDate(0, 0, 7)
			}
			return candidate, true
		}
	}
	return time.Time{}, false
}

func parseClock(value string) (int, int, bool) {
	if len(value) != 5 || value[2] != ':' {
		return 0, 0, false
	}
	hour := int(value[0]-'0')*10 + int(value[1]-'0')
	minute := int(value[3]-'0')*10 + int(value[4]-'0')
	if value[0] < '0' || value[0] > '9' || value[1] < '0' || value[1] > '9' ||
		value[3] < '0' || value[3] > '9' || value[4] < '0' || value[4] > '9' ||
		hour > 23 || minute > 59 {
		return 0, 0, false
	}
	return hour, minute, true
}
