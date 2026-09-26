package terminal

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestManagerRunsTwoShellsForOneTask(t *testing.T) {
	if os.Getenv("PI_DESK_LIVE_TEST") != "1" {
		t.Skip("set PI_DESK_LIVE_TEST=1 to run against the installed interactive shell")
	}
	events := make(chan Event, 128)
	manager := NewManager(context.Background(), func(event Event) { events <- event })
	t.Cleanup(manager.Shutdown)

	streams := map[string]*bytes.Buffer{"left": {}, "right": {}}
	generations := map[string]uint64{}
	for _, item := range []struct{ session, marker string }{{"left", "left"}, {"right", "right"}} {
		cwd := t.TempDir()
		started, err := manager.Start(StartConfig{ThreadID: "shell-pair", SessionID: item.session, CWD: cwd, Columns: 80, Rows: 24})
		if err != nil {
			t.Fatalf("start %s: %v", item.session, err)
		}
		if started.SessionID != item.session || started.Generation == 0 {
			t.Fatalf("started terminal kept its identity: %#v", started)
		}
		generations[item.session] = started.Generation
	}
	if generations["left"] == generations["right"] {
		t.Fatalf("two terminals of one task shared generation %d", generations["left"])
	}
	// The printf argument is assembled at run time on purpose: the terminal echoes the command
	// text back, and a literal marker in that echo would satisfy the assertion without the shell
	// ever having run anything.
	for _, item := range []struct{ session, marker string }{{"left", "left"}, {"right", "right"}} {
		if err := manager.Write("shell-pair", item.session, []byte("printf 'pi-desk-%s\\n' '"+item.marker+"'\n")); err != nil {
			t.Fatalf("write %s: %v", item.session, err)
		}
	}

	deadline := time.After(20 * time.Second)
	for !bothAnswered(streams) {
		select {
		case event := <-events:
			if event.Type != "output" || event.SessionID == "" {
				continue
			}
			if event.ThreadID != "shell-pair" {
				t.Fatalf("event lost its thread id: %#v", event)
			}
			streams[event.SessionID].Write(event.Data)
		case <-deadline:
			t.Fatalf("shells did not answer: left=%q right=%q", streams["left"].String(), streams["right"].String())
		}
	}
	// The real proof: each session saw only its own shell.
	if bytes.Contains(streams["left"].Bytes(), []byte("pi-desk-right")) || !bytes.Contains(streams["left"].Bytes(), []byte("pi-desk-left")) {
		t.Fatalf("left session leaked or missed output: %q", streams["left"].String())
	}
	if bytes.Contains(streams["right"].Bytes(), []byte("pi-desk-left")) || !bytes.Contains(streams["right"].Bytes(), []byte("pi-desk-right")) {
		t.Fatalf("right session leaked or missed output: %q", streams["right"].String())
	}

	if err := manager.Stop("shell-pair", "left"); err != nil {
		t.Fatal(err)
	}
	if state := manager.Snapshot("shell-pair", "right"); !state.Running {
		t.Fatal("stopping the left terminal stopped the right one")
	}
	if err := manager.StopThread("shell-pair"); err != nil {
		t.Fatal(err)
	}
}

func bothAnswered(streams map[string]*bytes.Buffer) bool {
	return bytes.Contains(streams["left"].Bytes(), []byte("pi-desk-left")) &&
		bytes.Contains(streams["right"].Bytes(), []byte("pi-desk-right"))
}
func TestManagerRunsInstalledInteractiveShell(t *testing.T) {
	if os.Getenv("PI_DESK_LIVE_TEST") != "1" {
		t.Skip("set PI_DESK_LIVE_TEST=1 to run against the installed interactive shell")
	}
	cwd := t.TempDir()
	events := make(chan Event, 32)
	manager := NewManager(context.Background(), func(event Event) { events <- event })
	t.Cleanup(manager.Shutdown)
	state, err := manager.Start(StartConfig{ThreadID: "shell-smoke", CWD: cwd, Columns: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	shell := strings.ToLower(filepath.Base(state.Shell))
	command := "printf 'pi-desk-%s\\n' 'terminal-smoke'\n"
	if runtime.GOOS == "windows" {
		if strings.HasPrefix(shell, "cmd") {
			command = "echo pi-desk-terminal^smoke\r"
		} else {
			command = "Write-Output ('pi-desk-' + 'terminal-smoke')\r"
		}
	}
	var output bytes.Buffer
	startupDeadline := time.After(10 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Type == "output" {
				_, _ = output.Write(event.Data)
				goto shellReady
			}
			if event.Type == "exit" {
				t.Fatalf("interactive shell exited during startup: %s", event.Error)
			}
		case <-startupDeadline:
			t.Fatal("interactive shell did not produce startup output")
		}
	}

shellReady:
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.After(20 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Type == "output" {
				_, _ = output.Write(event.Data)
			}
			if bytes.Contains(output.Bytes(), []byte("pi-desk-terminal-smoke")) {
				if err := manager.Stop("shell-smoke", ""); err != nil {
					t.Fatal(err)
				}
				return
			}
			if event.Type == "exit" {
				t.Fatalf("interactive shell exited before returning output: %s", event.Error)
			}
		case <-ticker.C:
			if err := manager.Write("shell-smoke", "", []byte(command)); err != nil {
				t.Fatal(err)
			}
		case <-deadline:
			_ = manager.Stop("shell-smoke", "")
			t.Fatalf("interactive shell did not execute input; output: %q", output.String())
		}
	}
}
