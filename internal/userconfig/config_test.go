package userconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"pi-desk/internal/appdirs"
)

// Every case pins the file inside a temporary home so a test run can never read
// or write the developer's real ~/.pi-desk.
func isolate(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // os.UserHomeDir on Windows
	t.Setenv(appdirs.DataDirEnv, "")
	t.Setenv(PathEnv, "")
	return home
}

func TestPathPrecedence(t *testing.T) {
	home := isolate(t)

	if got, err := Path(); err != nil || got != filepath.Join(home, ".pi-desk", FileName) {
		t.Fatalf("default path = %q (%v), want the home directory file", got, err)
	}

	sandbox := t.TempDir()
	t.Setenv(appdirs.DataDirEnv, sandbox)
	if got, err := Path(); err != nil || got != filepath.Join(sandbox, FileName) {
		t.Fatalf("sandbox path = %q (%v), want it inside %s", got, err, appdirs.DataDirEnv)
	}

	pinned := filepath.Join(t.TempDir(), "stream.json")
	t.Setenv(PathEnv, pinned)
	if got, err := Path(); err != nil || got != pinned {
		t.Fatalf("pinned path = %q (%v), want %q", got, err, pinned)
	}
}

func TestNormal(t *testing.T) {
	for _, testCase := range []struct{ in, want string }{
		{"", StreamPanelsAuto},
		{"auto", StreamPanelsAuto},
		{" alwaysOpen ", StreamPanelsAlwaysOpen},
		{"alwaysClosed", StreamPanelsAlwaysClosed},
	} {
		got, ok := Normal(testCase.in)
		if !ok || got != testCase.want {
			t.Errorf("Normal(%q) = %q,%v want %q,true", testCase.in, got, ok, testCase.want)
		}
	}
	for _, value := range []string{"ALWAYSOPEN", "yes", "follow"} {
		if got, ok := Normal(value); ok {
			t.Errorf("Normal(%q) accepted as %q", value, got)
		}
	}
}

func TestLoadMissingFileIsDefault(t *testing.T) {
	isolate(t)
	config, path, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if config.StreamPanels != StreamPanelsAuto {
		t.Fatalf("streamPanels = %q, want %q", config.StreamPanels, StreamPanelsAuto)
	}
	if path == "" {
		t.Fatal("path is empty")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("Load must not create the file, stat err = %v", err)
	}
}

func TestEnsureCreatesReadableFile(t *testing.T) {
	isolate(t)
	path, err := Ensure()
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read created file: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("created file is not valid JSON: %v", err)
	}
	if fields["streamPanels"] != StreamPanelsAuto {
		t.Fatalf("created file = %s", raw)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("created file mode = %v (%v)", info, err)
	}

	// A second Ensure must not clobber an edit.
	if _, err := Save(Config{StreamPanels: StreamPanelsAlwaysOpen}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := Ensure(); err != nil {
		t.Fatalf("second Ensure: %v", err)
	}
	config, _, err := Load()
	if err != nil || config.StreamPanels != StreamPanelsAlwaysOpen {
		t.Fatalf("Load after second Ensure = %+v (%v)", config, err)
	}
}

func TestSaveKeepsUnknownKeys(t *testing.T) {
	isolate(t)
	path, err := Path()
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("{\n  \"streamPanels\": \"alwaysClosed\",\n  \"futureToggle\": true\n}\n"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	config, _, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if config.StreamPanels != StreamPanelsAlwaysClosed {
		t.Fatalf("streamPanels = %q", config.StreamPanels)
	}
	if _, err := Save(Config{StreamPanels: StreamPanelsAlwaysOpen, extra: config.extra}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("saved file is not valid JSON: %v", err)
	}
	if string(fields["futureToggle"]) != "true" {
		t.Fatalf("unknown key was dropped: %s", raw)
	}
	if string(fields["streamPanels"]) != `"alwaysOpen"` {
		t.Fatalf("streamPanels was not written: %s", raw)
	}
}

func TestLoadTolerantOfBadInput(t *testing.T) {
	isolate(t)
	path, err := Path()
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	if err := os.WriteFile(path, []byte("{oops"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	config, _, err := Load()
	if err == nil {
		t.Fatal("broken JSON must be reported")
	}
	if config.StreamPanels != StreamPanelsAuto {
		t.Fatalf("broken JSON = %+v, want defaults", config)
	}

	// A value outside the enum is ignored instead of poisoning the UI.
	if err := os.WriteFile(path, []byte(`{"streamPanels":"yolo","other":1}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	config, _, err = Load()
	if err != nil {
		t.Fatalf("Load with unknown keys: %v", err)
	}
	if config.StreamPanels != StreamPanelsAuto {
		t.Fatalf("unknown mode = %q, want the default", config.StreamPanels)
	}
	if _, ok := config.extra["other"]; !ok {
		t.Fatal("unknown key was not preserved")
	}
}
