package terminal

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	ptylib "github.com/aymanbagabas/go-pty"
)

const (
	maxReplayBytes        = 1 << 20
	maxActiveSessions     = 32
	maxTerminalsPerThread = 8
)

var (
	ErrNotRunning    = errors.New("terminal is not running")
	ErrAlreadyClosed = errors.New("terminal manager is closed")
	ErrStopping      = errors.New("terminal is stopping")
	ErrLimitReached  = errors.New("terminal session limit reached")
	ErrThreadLimit   = errors.New("this task already has the maximum number of terminals")
)

type StartConfig struct {
	ThreadID  string
	SessionID string
	CWD       string
	Columns   int
	Rows      int
}

type Snapshot struct {
	ThreadID   string
	SessionID  string
	CWD        string
	Shell      string
	Running    bool
	Generation uint64
	Sequence   uint64
	Columns    int
	Rows       int
	Output     []byte
}

type Event struct {
	ThreadID   string
	SessionID  string
	Type       string
	Generation uint64
	Sequence   uint64
	Data       []byte
	ExitCode   int
	Error      string
	// EmittedAt is the wall-clock millisecond at which the pseudo-terminal produced Data. The pane
	// uses it to tell a query it can still answer in time from one that only surfaced after the app
	// was backgrounded; see stampEvent.
	EmittedAt int64
}

// stampEvent puts the wall-clock production time on an event. The pane only reads it for output, but
// stamping every kind keeps a caller from having to remember which ones carry bytes.
func stampEvent(event Event) Event {
	if event.EmittedAt == 0 {
		event.EmittedAt = time.Now().UnixMilli()
	}
	return event
}

type process interface {
	io.ReadWriteCloser
	Resize(int, int) error
	Wait() error
	Stop() error
	ExitCode() int
}

type starter interface {
	Start(context.Context, StartConfig) (process, string, error)
}

type osStarter struct{}

type osProcess struct {
	pty       ptylib.Pty
	command   *ptylib.Cmd
	closeOnce sync.Once
	closeErr  error
}

func (osStarter) Start(ctx context.Context, config StartConfig) (process, string, error) {
	pseudoterminal, err := ptylib.New()
	if err != nil {
		return nil, "", fmt.Errorf("create pseudo-terminal: %w", err)
	}
	shell, args, err := defaultShell()
	if err != nil {
		_ = pseudoterminal.Close()
		return nil, "", err
	}
	if err := pseudoterminal.Resize(config.Columns, config.Rows); err != nil {
		_ = pseudoterminal.Close()
		return nil, "", fmt.Errorf("resize pseudo-terminal: %w", err)
	}
	command := pseudoterminal.CommandContext(ctx, shell, args...)
	command.Dir = config.CWD
	command.Env = terminalEnvironment(os.Environ())
	if err := command.Start(); err != nil {
		_ = pseudoterminal.Close()
		return nil, "", fmt.Errorf("start shell: %w", err)
	}
	return &osProcess{pty: pseudoterminal, command: command}, shell, nil
}

func (process *osProcess) Read(data []byte) (int, error)  { return process.pty.Read(data) }
func (process *osProcess) Write(data []byte) (int, error) { return process.pty.Write(data) }
func (process *osProcess) Resize(columns, rows int) error { return process.pty.Resize(columns, rows) }
func (process *osProcess) Wait() error                    { return process.command.Wait() }

func (process *osProcess) Close() error {
	process.closeOnce.Do(func() { process.closeErr = process.pty.Close() })
	return process.closeErr
}

func (process *osProcess) Stop() error {
	var killErr error
	if process.command.Process != nil {
		killErr = process.command.Process.Kill()
		if errors.Is(killErr, os.ErrProcessDone) {
			killErr = nil
		}
	}
	return errors.Join(killErr, process.Close())
}

func (process *osProcess) ExitCode() int {
	if process.command.ProcessState == nil {
		return -1
	}
	return process.command.ProcessState.ExitCode()
}

type session struct {
	key       string
	info      Snapshot
	process   process
	stopping  bool
	finished  bool
	bufferMu  sync.Mutex
	processMu sync.Mutex
}

// sessionKey separates the several terminals one task can own. An empty session id keeps the
// legacy shape - one terminal per task, addressed by the task id alone - so a caller written
// before multi-terminal keeps working unchanged. The separator is a byte no thread id or UUID
// can contain, so no two pairs can collide.
func sessionKey(threadID, sessionID string) string {
	threadID, sessionID = strings.TrimSpace(threadID), strings.TrimSpace(sessionID)
	if sessionID == "" {
		return threadID
	}
	return threadID + "\x1f" + sessionID
}

type Manager struct {
	ctx            context.Context
	starter        starter
	onEvent        func(Event)
	mu             sync.Mutex
	sessions       map[string]*session
	nextGeneration uint64
	closed         bool
}

func NewManager(ctx context.Context, onEvent func(Event)) *Manager {
	return newManager(ctx, osStarter{}, onEvent)
}

func newManager(ctx context.Context, starter starter, onEvent func(Event)) *Manager {
	if ctx == nil {
		ctx = context.Background()
	}
	return &Manager{ctx: ctx, starter: starter, onEvent: onEvent, sessions: make(map[string]*session)}
}

func (manager *Manager) Start(config StartConfig) (Snapshot, error) {
	if err := validateStartConfig(config); err != nil {
		return Snapshot{}, err
	}
	key := sessionKey(config.ThreadID, config.SessionID)
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.closed {
		return Snapshot{}, ErrAlreadyClosed
	}
	if existing := manager.sessions[key]; existing != nil {
		if existing.isStopping() {
			return Snapshot{}, ErrStopping
		}
		if err := existing.resize(config.Columns, config.Rows); err != nil {
			return Snapshot{}, err
		}
		return existing.snapshot(), nil
	}
	if len(manager.sessions) >= maxActiveSessions {
		return Snapshot{}, ErrLimitReached
	}
	if manager.threadSessionCountLocked(config.ThreadID) >= maxTerminalsPerThread {
		return Snapshot{}, ErrThreadLimit
	}
	process, shell, err := manager.starter.Start(manager.ctx, config)
	if err != nil {
		return Snapshot{}, err
	}
	manager.nextGeneration++
	generation := manager.nextGeneration
	running := &session{
		key: key,
		info: Snapshot{
			ThreadID: config.ThreadID, SessionID: strings.TrimSpace(config.SessionID), CWD: config.CWD,
			Shell: shell, Running: true, Generation: generation, Columns: config.Columns, Rows: config.Rows,
		},
		process: process,
	}
	manager.sessions[key] = running
	go manager.read(running)
	go manager.wait(running)
	return running.snapshot(), nil
}

func (manager *Manager) threadSessionCountLocked(threadID string) int {
	threadID = strings.TrimSpace(threadID)
	count := 0
	for _, running := range manager.sessions {
		if running.info.ThreadID == threadID {
			count++
		}
	}
	return count
}

func (manager *Manager) Snapshot(threadID, sessionID string) Snapshot {
	key := sessionKey(threadID, sessionID)
	manager.mu.Lock()
	running := manager.sessions[key]
	manager.mu.Unlock()
	if running == nil {
		return Snapshot{ThreadID: strings.TrimSpace(threadID), SessionID: strings.TrimSpace(sessionID)}
	}
	return running.snapshot()
}

func (manager *Manager) Write(threadID, sessionID string, data []byte) error {
	running := manager.running(threadID, sessionID)
	if running == nil {
		return ErrNotRunning
	}
	running.processMu.Lock()
	defer running.processMu.Unlock()
	_, err := running.process.Write(data)
	return err
}

func (manager *Manager) Resize(threadID, sessionID string, columns, rows int) error {
	if err := validateDimensions(columns, rows); err != nil {
		return err
	}
	running := manager.running(threadID, sessionID)
	if running == nil {
		return ErrNotRunning
	}
	return running.resize(columns, rows)
}

func (manager *Manager) Stop(threadID, sessionID string) error {
	running := manager.running(threadID, sessionID)
	if running == nil {
		return ErrNotRunning
	}
	running.processMu.Lock()
	running.stopping = true
	err := running.process.Stop()
	running.processMu.Unlock()
	return err
}

// StopThread closes every terminal belonging to a task, whichever session ids they carry.
func (manager *Manager) StopThread(threadID string) error {
	keys := manager.threadKeys(threadID)
	if len(keys) == 0 {
		return ErrNotRunning
	}
	var errs []error
	for _, key := range keys {
		manager.mu.Lock()
		running := manager.sessions[key]
		manager.mu.Unlock()
		if running == nil {
			continue
		}
		running.processMu.Lock()
		running.stopping = true
		err := running.process.Stop()
		running.processMu.Unlock()
		if err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (manager *Manager) threadKeys(threadID string) []string {
	threadID = strings.TrimSpace(threadID)
	manager.mu.Lock()
	defer manager.mu.Unlock()
	keys := make([]string, 0, 1)
	for key, running := range manager.sessions {
		if running.info.ThreadID == threadID {
			keys = append(keys, key)
		}
	}
	return keys
}

func (manager *Manager) Shutdown() {
	manager.mu.Lock()
	if manager.closed {
		manager.mu.Unlock()
		return
	}
	manager.closed = true
	sessions := make([]*session, 0, len(manager.sessions))
	for _, running := range manager.sessions {
		sessions = append(sessions, running)
	}
	manager.mu.Unlock()
	for _, running := range sessions {
		running.processMu.Lock()
		running.stopping = true
		_ = running.process.Stop()
		running.processMu.Unlock()
	}
}

func (manager *Manager) running(threadID, sessionID string) *session {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.sessions[sessionKey(threadID, sessionID)]
}

func (manager *Manager) read(running *session) {
	buffer := make([]byte, 32<<10)
	for {
		count, err := running.process.Read(buffer)
		if count > 0 {
			data := append([]byte(nil), buffer[:count]...)
			sequence := running.appendOutput(data)
			manager.emit(Event{ThreadID: running.info.ThreadID, SessionID: running.info.SessionID, Type: "output", Generation: running.info.Generation, Sequence: sequence, Data: data})
		}
		if err != nil {
			if !isTerminalTeardown(err) && !running.suppressReadError() {
				sequence := running.nextSequence()
				manager.emit(Event{ThreadID: running.info.ThreadID, SessionID: running.info.SessionID, Type: "error", Generation: running.info.Generation, Sequence: sequence, Error: err.Error()})
			}
			return
		}
	}
}

func (manager *Manager) wait(running *session) {
	err := running.process.Wait()
	running.processMu.Lock()
	running.finished = true
	stopping := running.stopping
	running.processMu.Unlock()
	_ = running.process.Close()
	manager.mu.Lock()
	if manager.sessions[running.key] == running {
		delete(manager.sessions, running.key)
	}
	manager.mu.Unlock()
	event := Event{ThreadID: running.info.ThreadID, SessionID: running.info.SessionID, Type: "exit", Generation: running.info.Generation, Sequence: running.nextSequence(), ExitCode: running.process.ExitCode()}
	// A shell inherits the status of its last command, so `exit` after a failed command reaches us
	// as *exec.ExitError. That is a normal exit, not a stream failure; reporting it as an error
	// used to paint a red bar over the stopped terminal and suppress its start affordance.
	var exitErr *exec.ExitError
	if err != nil && !stopping && !errors.As(err, &exitErr) {
		event.Error = err.Error()
	}
	manager.emit(event)
}

// isTerminalTeardown reports the errors a pseudo-terminal answers with the moment its child is
// reaped. On macOS the master fd turns EIO before wait() can mark the session finished, so the
// race used to surface a spurious stream error on every clean exit.
func isTerminalTeardown(err error) bool {
	return errors.Is(err, io.EOF) ||
		errors.Is(err, io.ErrClosedPipe) ||
		errors.Is(err, os.ErrClosed) ||
		errors.Is(err, syscall.EIO)
}

func (manager *Manager) emit(event Event) {
	if manager.onEvent != nil {
		manager.onEvent(stampEvent(event))
	}
}

func (running *session) snapshot() Snapshot {
	running.bufferMu.Lock()
	defer running.bufferMu.Unlock()
	result := running.info
	result.Output = append([]byte(nil), running.info.Output...)
	return result
}

func (running *session) appendOutput(data []byte) uint64 {
	running.bufferMu.Lock()
	defer running.bufferMu.Unlock()
	running.info.Sequence++
	if len(data) >= maxReplayBytes {
		running.info.Output = append(running.info.Output[:0], data[len(data)-maxReplayBytes:]...)
		return running.info.Sequence
	}
	overflow := len(running.info.Output) + len(data) - maxReplayBytes
	if overflow > 0 {
		copy(running.info.Output, running.info.Output[overflow:])
		running.info.Output = running.info.Output[:len(running.info.Output)-overflow]
	}
	running.info.Output = append(running.info.Output, data...)
	return running.info.Sequence
}

func (running *session) nextSequence() uint64 {
	running.bufferMu.Lock()
	defer running.bufferMu.Unlock()
	running.info.Sequence++
	return running.info.Sequence
}

func (running *session) resize(columns, rows int) error {
	if err := validateDimensions(columns, rows); err != nil {
		return err
	}
	running.processMu.Lock()
	err := running.process.Resize(columns, rows)
	running.processMu.Unlock()
	if err != nil {
		return err
	}
	running.setGeometry(columns, rows)
	return nil
}

// setGeometry records the size the pseudo-terminal answers to right now. The replay buffer holds raw
// bytes, so it is only meaningful at the geometry it was produced at: a pane that re-mounts has to
// hand those bytes to a terminal of that same size before it fits itself to the layout, or xterm
// reflows a running program's cursor addressing into mojibake and every later line wraps in the wrong
// column - which is what pasted text looked like after switching tasks and back.
func (running *session) setGeometry(columns, rows int) {
	running.bufferMu.Lock()
	defer running.bufferMu.Unlock()
	running.info.Columns, running.info.Rows = columns, rows
}

func (running *session) isStopping() bool {
	running.processMu.Lock()
	defer running.processMu.Unlock()
	return running.stopping
}

func (running *session) suppressReadError() bool {
	running.processMu.Lock()
	defer running.processMu.Unlock()
	return running.stopping || running.finished
}

func validateStartConfig(config StartConfig) error {
	if strings.TrimSpace(config.ThreadID) == "" {
		return errors.New("terminal thread id is required")
	}
	if strings.TrimSpace(config.CWD) == "" {
		return errors.New("terminal working directory is required")
	}
	return validateDimensions(config.Columns, config.Rows)
}

func validateDimensions(columns, rows int) error {
	if columns < 20 || columns > 500 || rows < 5 || rows > 300 {
		return errors.New("terminal dimensions are outside the supported range")
	}
	return nil
}

func terminalEnvironment(environment []string) []string {
	result := append([]string(nil), environment...)
	for key, value := range map[string]string{"TERM": "xterm-256color", "COLORTERM": "truecolor"} {
		prefix := key + "="
		replaced := false
		for index := range result {
			if strings.EqualFold(strings.SplitN(result[index], "=", 2)[0]+"=", prefix) {
				result[index] = prefix + value
				replaced = true
			}
		}
		if !replaced {
			result = append(result, prefix+value)
		}
	}
	return result
}
