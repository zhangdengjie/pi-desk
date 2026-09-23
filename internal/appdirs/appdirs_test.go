package appdirs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStatePathFollowsDataDirOverride(t *testing.T) {
	t.Setenv(DataDirEnv, "/tmp/pi-desk-sandbox")
	t.Setenv("HOME", "/tmp/should-not-be-used")

	statePath, err := StatePath()
	if err != nil {
		t.Fatalf("StatePath: %v", err)
	}
	if statePath != filepath.Join("/tmp/pi-desk-sandbox", "state.json") {
		t.Fatalf("state path = %q, want the override directory", statePath)
	}
	if profile, err := BrowserProfileDir(); err != nil {
		t.Fatalf("BrowserProfileDir: %v", err)
	} else if profile != filepath.Join("/tmp/pi-desk-sandbox", "browser") {
		t.Fatalf("browser profile = %q, want it beside the state file", profile)
	}
	if !Overridden() {
		t.Fatal("expected Overridden to report the active override")
	}
}

func TestStatePathExpandsHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv(DataDirEnv, "~/pi-desk-sandbox")

	statePath, err := StatePath()
	if err != nil {
		t.Fatalf("StatePath: %v", err)
	}
	if want := filepath.Join(home, "pi-desk-sandbox", "state.json"); statePath != want {
		t.Fatalf("state path = %q, want %q", statePath, want)
	}
}

func TestStatePathDefaultsToUserConfigDir(t *testing.T) {
	t.Setenv(DataDirEnv, "")
	t.Setenv("LOCALAPPDATA", "")

	config, err := os.UserConfigDir()
	if err != nil {
		t.Fatalf("UserConfigDir: %v", err)
	}
	statePath, err := StatePath()
	if err != nil {
		t.Fatalf("StatePath: %v", err)
	}
	if want := filepath.Join(config, "pi-desk", "state.json"); statePath != want {
		t.Fatalf("state path = %q, want %q", statePath, want)
	}
	if profile, err := BrowserProfileDir(); err != nil {
		t.Fatalf("BrowserProfileDir: %v", err)
	} else if want := filepath.Join(config, "pi-desk", "browser"); profile != want {
		t.Fatalf("browser profile = %q, want %q", profile, want)
	}
	if Overridden() {
		t.Fatal("expected no override to be reported")
	}
}

func TestInstanceIDForKeepsDefaultLockAndScopesSandboxLock(t *testing.T) {
	t.Setenv(DataDirEnv, "")

	defaultPath, err := StatePath()
	if err != nil {
		t.Fatalf("StatePath: %v", err)
	}
	if got := InstanceIDFor(defaultPath); got != defaultInstanceID {
		t.Fatalf("default lock id = %q, want the historical %q", got, defaultInstanceID)
	}

	sandbox := filepath.Join(t.TempDir(), "state.json")
	got := InstanceIDFor(sandbox)
	if got == defaultInstanceID {
		t.Fatal("a sandbox instance must not reuse the default lock, it would be refused by it")
	}
	if !strings.HasPrefix(got, defaultInstanceID+"-") {
		t.Fatalf("sandbox lock id = %q, want it derived from %q", got, defaultInstanceID)
	}
	if got != InstanceIDFor(sandbox) {
		t.Fatal("lock id must be stable for the same data directory, two sandboxes must still block each other")
	}
	if other := InstanceIDFor(filepath.Join(t.TempDir(), "state.json")); other == got {
		t.Fatalf("two different data directories share lock id %q", other)
	}
	// The temp-dir path is resolved through HOME on darwin only for the default; make sure a
	// relative override still gets a distinct id rather than panicking.
	if relative := InstanceIDFor("state.json"); relative == "" {
		t.Fatal("expected a non-empty id for a relative path")
	}
}

func TestMain(m *testing.M) {
	// Nothing in these tests may read the developer's real PI_DESK_DATA_DIR.
	os.Unsetenv(DataDirEnv)
	os.Exit(m.Run())
}
