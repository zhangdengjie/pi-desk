package appservice

import (
	"os"
	"strings"
)

const (
	R2WorktreeEnv  = "PI_DESK_R2_WORKTREE"
	R2SchedulerEnv = "PI_DESK_R2_SCHEDULER"
)

// R2WorktreeEnabled is opt-in until the worktree UI and bootstrap flow have
// been verified; setting the env to 1/true/on enables the entry points.
func R2WorktreeEnabled() bool { return envSwitch(R2WorktreeEnv) }

// R2SchedulerEnabled is opt-in until the frontend schedule page reads the Go
// store. Leaving the old frontend timer in charge is the safe default.
func R2SchedulerEnabled() bool { return envSwitch(R2SchedulerEnv) }

func envSwitch(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "on", "yes":
		return true
	default:
		return false
	}
}
