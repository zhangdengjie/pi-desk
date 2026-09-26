package terminal

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"syscall"
	"testing"
	"time"
)

type fakeStarter struct {
	process *fakeProcess
	starts  int
	config  StartConfig
}

func (starter *fakeStarter) Start(_ context.Context, config StartConfig) (process, string, error) {
	starter.starts++
	starter.config = config
	return starter.process, "test-shell", nil
}

type fakeProcess struct {
	reader    *io.PipeReader
	output    *io.PipeWriter
	wait      chan struct{}
	stopOnce  sync.Once
	closeOnce sync.Once
	mu        sync.Mutex
	input     bytes.Buffer
	columns   int
	rows      int
	exitCode  int
	waitErr   error
}

func newFakeProcess() *fakeProcess {
	reader, output := io.Pipe()
	return &fakeProcess{reader: reader, output: output, wait: make(chan struct{})}
}

func (process *fakeProcess) Read(data []byte) (int, error) {
	return process.reader.Read(data)
}

func (process *fakeProcess) Write(data []byte) (int, error) {
	process.mu.Lock()
	defer process.mu.Unlock()
	return process.input.Write(data)
}

func (process *fakeProcess) Resize(columns, rows int) error {
	process.mu.Lock()
	defer process.mu.Unlock()
	process.columns, process.rows = columns, rows
	return nil
}

func (process *fakeProcess) Wait() error {
	<-process.wait
	return process.waitErr
}

func (process *fakeProcess) Stop() error {
	process.stopOnce.Do(func() {
		close(process.wait)
		_ = process.output.Close()
	})
	return nil
}

func (process *fakeProcess) Close() error {
	process.closeOnce.Do(func() {
		_ = process.output.Close()
		_ = process.reader.Close()
	})
	return nil
}

func (process *fakeProcess) ExitCode() int { return process.exitCode }

func (process *fakeProcess) inputString() string {
	process.mu.Lock()
	defer process.mu.Unlock()
	return process.input.String()
}

func TestManagerExitsWithShellStatusWithoutReportingAnError(t *testing.T) {
	process := newFakeProcess()
	process.exitCode = 1
	// `exit` in zsh/bash inherits the status of the previous command, which exec reports as
	// *exec.ExitError. The terminal stopped legitimately and must not surface as a stream failure.
	process.waitErr = &exec.ExitError{}
	starter := &fakeStarter{process: process}
	events := make(chan Event, 4)
	manager := newManager(context.Background(), starter, func(event Event) { events <- event })
	t.Cleanup(manager.Shutdown)

	if _, err := manager.Start(StartConfig{ThreadID: "thread-1", CWD: t.TempDir(), Columns: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	close(process.wait)
	exit := waitForTerminalEvent(t, events, "exit")
	if exit.ExitCode != 1 || exit.Error != "" {
		t.Fatalf("nonzero exit was reported as an error: %#v", exit)
	}
}

func TestManagerReportsWaitFailureThatIsNotAnExitStatus(t *testing.T) {
	process := newFakeProcess()
	process.waitErr = errors.New("wait: no child process")
	starter := &fakeStarter{process: process}
	events := make(chan Event, 4)
	manager := newManager(context.Background(), starter, func(event Event) { events <- event })
	t.Cleanup(manager.Shutdown)

	if _, err := manager.Start(StartConfig{ThreadID: "thread-1", CWD: t.TempDir(), Columns: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	close(process.wait)
	exit := waitForTerminalEvent(t, events, "exit")
	if exit.Error != "wait: no child process" {
		t.Fatalf("real wait failure was swallowed: %#v", exit)
	}
}

func TestTerminalTeardownErrorsAreSuppressed(t *testing.T) {
	for _, err := range []error{io.EOF, io.ErrClosedPipe, syscall.EIO, fmt.Errorf("read pseudo-terminal: %w", syscall.EIO)} {
		if !isTerminalTeardown(err) {
			t.Fatalf("%v must count as a teardown error", err)
		}
	}
	if isTerminalTeardown(errors.New("terminal read failed")) {
		t.Fatal("an unrelated read error was classified as teardown")
	}
}

func TestManagerRunsOneTerminalPerThreadAndReplaysOutput(t *testing.T) {
	process := newFakeProcess()
	starter := &fakeStarter{process: process}
	events := make(chan Event, 4)
	manager := newManager(context.Background(), starter, func(event Event) { events <- event })
	t.Cleanup(manager.Shutdown)

	state, err := manager.Start(StartConfig{ThreadID: "thread-1", CWD: t.TempDir(), Columns: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	if !state.Running || state.Shell != "test-shell" || state.Generation == 0 || starter.starts != 1 {
		t.Fatalf("unexpected terminal state: %#v", state)
	}
	if _, err := manager.Start(StartConfig{ThreadID: "thread-1", CWD: starter.config.CWD, Columns: 100, Rows: 30}); err != nil {
		t.Fatal(err)
	}
	if starter.starts != 1 || process.columns != 100 || process.rows != 30 {
		t.Fatalf("existing terminal was not reused and resized: starts=%d size=%dx%d", starter.starts, process.columns, process.rows)
	}

	if _, err := process.output.Write([]byte("hello\r\n")); err != nil {
		t.Fatal(err)
	}
	output := waitForTerminalEvent(t, events, "output")
	if string(output.Data) != "hello\r\n" || output.Generation != state.Generation || output.Sequence != 1 {
		t.Fatalf("unexpected output event: %#v", output)
	}
	state = manager.Snapshot("thread-1", "")
	if string(state.Output) != "hello\r\n" || state.Sequence != 1 {
		t.Fatalf("unexpected replay state: %#v", state)
	}

	if err := manager.Write("thread-1", "", []byte("pwd\r")); err != nil {
		t.Fatal(err)
	}
	if process.inputString() != "pwd\r" {
		t.Fatalf("unexpected terminal input %q", process.inputString())
	}
	if err := manager.Stop("thread-1", ""); err != nil {
		t.Fatal(err)
	}
	exit := waitForTerminalEvent(t, events, "exit")
	if exit.ExitCode != 0 || exit.Error != "" {
		t.Fatalf("unexpected exit event: %#v", exit)
	}
	if state := manager.Snapshot("thread-1", ""); state.Running {
		t.Fatal("stopped terminal remained registered")
	}
}

func TestManagerRejectsLateExitFromPreviousGeneration(t *testing.T) {
	first := newFakeProcess()
	second := newFakeProcess()
	starter := &sequenceStarter{processes: []*fakeProcess{first, second}}
	events := make(chan Event, 4)
	manager := newManager(context.Background(), starter, func(event Event) { events <- event })
	t.Cleanup(manager.Shutdown)

	initial, err := manager.Start(StartConfig{ThreadID: "thread-1", CWD: t.TempDir(), Columns: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Stop("thread-1", ""); err != nil {
		t.Fatal(err)
	}
	oldExit := waitForTerminalEvent(t, events, "exit")
	if oldExit.Generation != initial.Generation {
		t.Fatalf("old exit generation=%d initial=%d", oldExit.Generation, initial.Generation)
	}

	current, err := manager.Start(StartConfig{ThreadID: "thread-1", CWD: starter.config.CWD, Columns: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	if current.Generation <= initial.Generation {
		t.Fatalf("generation did not advance: initial=%d current=%d", initial.Generation, current.Generation)
	}
	if oldExit.Generation == current.Generation {
		t.Fatal("previous terminal exit was indistinguishable from current terminal")
	}
	_ = manager.Stop("thread-1", "")
	_ = waitForTerminalEvent(t, events, "exit")
}

type sequenceStarter struct {
	processes []*fakeProcess
	index     int
	config    StartConfig
}

func (starter *sequenceStarter) Start(_ context.Context, config StartConfig) (process, string, error) {
	starter.config = config
	process := starter.processes[starter.index]
	starter.index++
	return process, "test-shell", nil
}

func TestManagerBoundsReplayAndValidatesRequests(t *testing.T) {
	running := &session{info: Snapshot{ThreadID: "thread-1", Running: true}}
	large := bytes.Repeat([]byte("a"), maxReplayBytes+512)
	running.appendOutput(large)
	state := running.snapshot()
	if len(state.Output) != maxReplayBytes || state.Sequence != 1 {
		t.Fatalf("replay buffer was not bounded: bytes=%d sequence=%d", len(state.Output), state.Sequence)
	}

	manager := newManager(context.Background(), &fakeStarter{process: newFakeProcess()}, nil)
	if _, err := manager.Start(StartConfig{ThreadID: "", CWD: t.TempDir(), Columns: 80, Rows: 24}); err == nil {
		t.Fatal("expected empty thread id to fail")
	}
	if _, err := manager.Start(StartConfig{ThreadID: "thread-1", CWD: t.TempDir(), Columns: 2, Rows: 2}); err == nil {
		t.Fatal("expected invalid dimensions to fail")
	}
	if err := manager.Write("missing", "", []byte("x")); err != ErrNotRunning {
		t.Fatalf("expected ErrNotRunning, got %v", err)
	}
	manager.mu.Lock()
	for index := 0; index < maxActiveSessions; index++ {
		threadID := string(rune('a' + index))
		manager.sessions[threadID] = &session{info: Snapshot{ThreadID: threadID, Running: true}}
	}
	manager.mu.Unlock()
	if _, err := manager.Start(StartConfig{ThreadID: "over-limit", CWD: t.TempDir(), Columns: 80, Rows: 24}); err != ErrLimitReached {
		t.Fatalf("expected ErrLimitReached, got %v", err)
	}
	manager.mu.Lock()
	manager.sessions = make(map[string]*session)
	manager.mu.Unlock()
	manager.Shutdown()
	if _, err := manager.Start(StartConfig{ThreadID: "thread-2", CWD: t.TempDir(), Columns: 80, Rows: 24}); err != ErrAlreadyClosed {
		t.Fatalf("expected ErrAlreadyClosed, got %v", err)
	}
}

func TestManagerKeepsTerminalsOfOneTaskApart(t *testing.T) {
	left, right := newFakeProcess(), newFakeProcess()
	starter := &sequenceStarter{processes: []*fakeProcess{left, right}}
	events := make(chan Event, 8)
	manager := newManager(context.Background(), starter, func(event Event) { events <- event })
	t.Cleanup(manager.Shutdown)

	dir := t.TempDir()
	first, err := manager.Start(StartConfig{ThreadID: "thread-1", SessionID: "session-a", CWD: dir, Columns: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.Start(StartConfig{ThreadID: "thread-1", SessionID: "session-b", CWD: dir, Columns: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	if first.Generation == second.Generation {
		t.Fatalf("two terminals of one task shared generation %d", first.Generation)
	}

	if err := manager.Write("thread-1", "session-b", []byte("ls\r")); err != nil {
		t.Fatal(err)
	}
	if left.inputString() != "" || right.inputString() != "ls\r" {
		t.Fatalf("input reached the wrong terminal: a=%q b=%q", left.inputString(), right.inputString())
	}
	if _, err := right.output.Write([]byte("b\r\n")); err != nil {
		t.Fatal(err)
	}
	event := waitForTerminalEvent(t, events, "output")
	if event.ThreadID != "thread-1" || event.SessionID != "session-b" {
		t.Fatalf("output event lost its session id: %#v", event)
	}

	if err := manager.Stop("thread-1", "session-a"); err != nil {
		t.Fatal(err)
	}
	waitForTerminalEvent(t, events, "exit")
	if state := manager.Snapshot("thread-1", "session-b"); !state.Running || state.SessionID != "session-b" {
		t.Fatalf("stopping a sibling stopped this terminal: %#v", state)
	}

	if err := manager.StopThread("thread-1"); err != nil {
		t.Fatal(err)
	}
	waitForTerminalEvent(t, events, "exit")
	if state := manager.Snapshot("thread-1", "session-b"); state.Running {
		t.Fatal("StopThread left a terminal of the task running")
	}
}

func TestManagerCapsTerminalsPerTask(t *testing.T) {
	processes := make([]*fakeProcess, maxTerminalsPerThread+1)
	for index := range processes {
		processes[index] = newFakeProcess()
	}
	manager := newManager(context.Background(), &sequenceStarter{processes: processes}, nil)
	t.Cleanup(manager.Shutdown)

	dir := t.TempDir()
	for index := 0; index < maxTerminalsPerThread; index++ {
		if _, err := manager.Start(StartConfig{ThreadID: "thread-1", SessionID: fmt.Sprintf("session-%d", index), CWD: dir, Columns: 80, Rows: 24}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := manager.Start(StartConfig{ThreadID: "thread-1", SessionID: "one-too-many", CWD: dir, Columns: 80, Rows: 24}); err != ErrThreadLimit {
		t.Fatalf("expected ErrThreadLimit, got %v", err)
	}
	if _, err := manager.Start(StartConfig{ThreadID: "thread-2", CWD: dir, Columns: 80, Rows: 24}); err != nil {
		t.Fatalf("a second task was blocked by the first: %v", err)
	}
}

// The replay buffer is raw bytes, so it only makes sense at the width it was produced at. A pane that
// re-mounts (switching tasks and back) replays before it fits itself to the layout, and without this
// number it has to guess - guessing wrong reflows a running program's cursor addressing into mojibake.
func TestSnapshotReportsTheGeometryTheReplayWasProducedAt(t *testing.T) {
	process := newFakeProcess()
	manager := newManager(context.Background(), &fakeStarter{process: process}, func(Event) {})
	t.Cleanup(manager.Shutdown)

	if _, err := manager.Start(StartConfig{ThreadID: "thread-1", CWD: t.TempDir(), Columns: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	if state := manager.Snapshot("thread-1", ""); state.Columns != 80 || state.Rows != 24 {
		t.Fatalf("start did not record the geometry: %#v", state)
	}

	if err := manager.Resize("thread-1", "", 132, 43); err != nil {
		t.Fatal(err)
	}
	if state := manager.Snapshot("thread-1", ""); state.Columns != 132 || state.Rows != 43 || process.columns != 132 || process.rows != 43 {
		t.Fatalf("resize did not follow the geometry: snapshot=%dx%d pty=%dx%d", state.Columns, state.Rows, process.columns, process.rows)
	}

	// A session that is not running has no geometry to promise; the pane falls back to fitting blind.
	if empty := manager.Snapshot("no-such-thread", ""); empty.Columns != 0 || empty.Rows != 0 {
		t.Fatalf("unknown session reported a geometry: %#v", empty)
	}
}

// The pane needs to know how old a chunk is: a query that surfaces after the app was backgrounded has
// no reader left to receive its reply, and writing one is the same as typing into the shell.
func TestOutputEventsCarryTheTimeThePseudoTerminalProducedThem(t *testing.T) {
	process := newFakeProcess()
	events := make(chan Event, 4)
	manager := newManager(context.Background(), &fakeStarter{process: process}, func(event Event) { events <- event })
	t.Cleanup(manager.Shutdown)

	if _, err := manager.Start(StartConfig{ThreadID: "thread-1", CWD: t.TempDir(), Columns: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	if _, err := process.output.Write([]byte("hi\r\n")); err != nil {
		t.Fatal(err)
	}

	event := waitForTerminalEvent(t, events, "output")
	if event.EmittedAt == 0 || event.EmittedAt > time.Now().UnixMilli()+1000 {
		t.Fatalf("output event carries an implausible production time: %d", event.EmittedAt)
	}
}

func waitForTerminalEvent(t *testing.T, events <-chan Event, eventType string) Event {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Type == eventType {
				return event
			}
		case <-deadline:
			t.Fatalf("timed out waiting for terminal %s event", eventType)
		}
	}
}
