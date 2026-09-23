package main

import (
	"testing"

	"pi-desk/internal/appdirs"
	"pi-desk/internal/domain"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// defaultStatePathInTest resolves the state path a normal desktop run would use, i.e. with no
// PI_DESK_DATA_DIR override in the environment.
func defaultStatePathInTest(t *testing.T) string {
	t.Helper()
	t.Setenv(appdirs.DataDirEnv, "")
	path, err := appdirs.StatePath()
	if err != nil {
		t.Fatalf("resolve default state path: %v", err)
	}
	return path
}

func TestCenteredWindowStateFitsFirstLaunchToPrimaryWorkArea(t *testing.T) {
	screens := []*application.Screen{{
		ID: "primary", IsPrimary: true,
		WorkArea: application.Rect{X: 0, Y: 0, Width: 1536, Height: 824},
	}}

	got := centeredWindowState(1440, 900, screens)
	want := domain.WindowState{X: 48, Y: 0, Width: 1440, Height: 824, Valid: true}
	if got != want {
		t.Fatalf("centered state = %#v, want %#v", got, want)
	}
}

func TestCenteredWindowStateDefersToPlatformWithoutScreenData(t *testing.T) {
	if got := centeredWindowState(1440, 900, nil); got.Valid {
		t.Fatalf("centered state without screens = %#v, want invalid platform default", got)
	}
}

func TestFirstLaunchMaximisesOnCompactHighDPILogicalWorkArea(t *testing.T) {
	screens := []*application.Screen{{
		ID: "primary", IsPrimary: true,
		WorkArea: application.Rect{X: 0, Y: 0, Width: 1536, Height: 816},
	}}
	state := centeredWindowState(defaultWindowWidth, defaultWindowHeight, screens)

	if !shouldMaximiseFirstLaunch(state, screens) {
		t.Fatalf("first launch state %#v should maximise on compact work area", state)
	}
}

func TestFirstLaunchStaysNormalOnRoomyWorkArea(t *testing.T) {
	screens := []*application.Screen{{
		ID: "primary", IsPrimary: true,
		WorkArea: application.Rect{X: 0, Y: 0, Width: 2560, Height: 1400},
	}}
	state := centeredWindowState(defaultWindowWidth, defaultWindowHeight, screens)

	if shouldMaximiseFirstLaunch(state, screens) {
		t.Fatalf("first launch state %#v should stay normal on roomy work area", state)
	}
}

func TestConstrainWindowStateRaisesTinySavedBoundsToMinimum(t *testing.T) {
	screens := []*application.Screen{{
		ID: "primary", IsPrimary: true,
		WorkArea: application.Rect{X: 0, Y: 0, Width: 1920, Height: 1040},
	}}
	state := domain.WindowState{X: 1800, Y: 900, Width: 420, Height: 300, Valid: true}

	got := constrainWindowState(state, screens)
	want := domain.WindowState{X: 940, Y: 360, Width: minimumWindowWidth, Height: minimumWindowHeight, Valid: true}
	if got != want {
		t.Fatalf("constrained tiny state = %#v, want %#v", got, want)
	}
}

func TestConstrainWindowStateKeepsWindowInsideCurrentWorkArea(t *testing.T) {
	screens := []*application.Screen{{
		ID: "primary", IsPrimary: true,
		WorkArea: application.Rect{X: 0, Y: 0, Width: 1920, Height: 1040},
	}}
	state := domain.WindowState{X: -24, Y: -38, Width: 2000, Height: 1100, Maximized: true, Valid: true}

	got := constrainWindowState(state, screens)
	want := domain.WindowState{X: 0, Y: 0, Width: 1920, Height: 1040, Maximized: true, Valid: true}
	if got != want {
		t.Fatalf("constrained state = %#v, want %#v", got, want)
	}
}

func TestConstrainWindowStatePreservesValidSecondaryMonitorPlacement(t *testing.T) {
	screens := []*application.Screen{
		{ID: "primary", IsPrimary: true, WorkArea: application.Rect{X: 0, Y: 0, Width: 1920, Height: 1040}},
		{ID: "left", WorkArea: application.Rect{X: -1280, Y: 40, Width: 1280, Height: 984}},
	}
	state := domain.WindowState{X: -1200, Y: 80, Width: 1100, Height: 800, Valid: true}

	if got := constrainWindowState(state, screens); got != state {
		t.Fatalf("valid secondary placement changed from %#v to %#v", state, got)
	}
}

func TestConstrainWindowStateCentersDetachedWindowOnPrimaryScreen(t *testing.T) {
	screens := []*application.Screen{
		{ID: "primary", IsPrimary: true, WorkArea: application.Rect{X: 0, Y: 24, Width: 1600, Height: 876}},
		{ID: "right", WorkArea: application.Rect{X: 1600, Y: 0, Width: 1920, Height: 1040}},
	}
	state := domain.WindowState{X: 5200, Y: -900, Width: 1200, Height: 700, Valid: true}

	got := constrainWindowState(state, screens)
	if got.X != 200 || got.Y != 112 || got.Width != 1200 || got.Height != 700 {
		t.Fatalf("detached state = %#v, want centered primary placement", got)
	}
}

func TestConstrainWindowStateLeavesInvalidStateUntouched(t *testing.T) {
	state := domain.WindowState{X: -5000, Y: -5000, Width: 0, Height: 0}
	screens := []*application.Screen{{ID: "primary", IsPrimary: true, WorkArea: application.Rect{Width: 1920, Height: 1040}}}

	if got := constrainWindowState(state, screens); got != state {
		t.Fatalf("invalid state changed from %#v to %#v", state, got)
	}
}

func TestSingleInstanceOptionsBlocksSecondProcessUnlessOptedOut(t *testing.T) {
	t.Setenv("PI_DESK_ALLOW_MULTI_INSTANCE", "")
	options := singleInstanceOptions(defaultStatePathInTest(t))
	if options == nil {
		t.Fatal("expected a second Pi Desk process to be refused by default")
	}
	if options.UniqueID == "" {
		t.Fatal("expected a stable unique id for the lock file")
	}
	if options.OnSecondInstanceLaunch == nil {
		t.Fatal("expected the existing window to be raised when a second launch is refused")
	}

	t.Setenv("PI_DESK_ALLOW_MULTI_INSTANCE", "1")
	if got := singleInstanceOptions("/tmp/whatever/state.json"); got != nil {
		t.Fatalf("expected the opt-out to disable the lock, got %+v", got)
	}
}

func TestSingleInstanceOptionsScopesTheLockToTheDataDirectory(t *testing.T) {
	t.Setenv("PI_DESK_ALLOW_MULTI_INSTANCE", "")

	defaultOptions := singleInstanceOptions(defaultStatePathInTest(t))
	sandboxOptions := singleInstanceOptions("/tmp/pi-desk-sandbox/state.json")
	if defaultOptions.UniqueID == sandboxOptions.UniqueID {
		t.Fatalf(
			"a sandbox instance would be refused by the running desktop: both use lock %q",
			defaultOptions.UniqueID,
		)
	}
	if again := singleInstanceOptions("/tmp/pi-desk-sandbox/state.json"); again.UniqueID != sandboxOptions.UniqueID {
		t.Fatal("two processes on the same data directory must still block each other")
	}
}

func TestInstanceTitleMarksSandboxRuns(t *testing.T) {
	t.Setenv(appdirs.DataDirEnv, "")
	if got := instanceTitle(); got != "Pi Desk" {
		t.Fatalf("title = %q, want the unbranded default", got)
	}
	t.Setenv(appdirs.DataDirEnv, "/tmp/pi-desk-sandbox")
	if got := instanceTitle(); got == "Pi Desk" {
		t.Fatal("a verification instance must be distinguishable in the title bar and tray")
	}
}
