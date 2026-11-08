package appservice

import (
	"os"
	"strings"
)

const (
	R2WorktreeEnv  = "PI_DESK_R2_WORKTREE"
	R2SchedulerEnv = "PI_DESK_R2_SCHEDULER"
)

// R2WorktreeEnabled is on by default after the R2 acceptance; set
// PI_DESK_R2_WORKTREE=0 to hide the isolated-worktree entry point.
func R2WorktreeEnabled() bool { return envSwitchDefaultOn(R2WorktreeEnv) }

// R2SchedulerEnabled is on by default after the R2 acceptance; set
// PI_DESK_R2_SCHEDULER=0 to return to the legacy frontend timer.
func R2SchedulerEnabled() bool { return envSwitchDefaultOn(R2SchedulerEnv) }

func envSwitchDefaultOn(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "0", "false", "off", "no":
		return false
	default:
		return true
	}
}
