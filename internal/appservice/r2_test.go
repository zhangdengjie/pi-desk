package appservice

import "testing"

func TestR2SwitchesDefaultOnAndCanBeDisabled(t *testing.T) {
	for _, name := range []string{R2WorktreeEnv, R2SchedulerEnv} {
		t.Setenv(name, "")
		if !envSwitchDefaultOn(name) {
			t.Fatalf("%s should default on", name)
		}
		for _, value := range []string{"0", "false", "off", "no", " OFF "} {
			t.Setenv(name, value)
			if envSwitchDefaultOn(name) {
				t.Fatalf("%s=%q should be disabled", name, value)
			}
		}
		for _, value := range []string{"1", "true", "on"} {
			t.Setenv(name, value)
			if !envSwitchDefaultOn(name) {
				t.Fatalf("%s=%q should be enabled", name, value)
			}
		}
	}
}
