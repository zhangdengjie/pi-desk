package terminal

import (
	"context"
	"errors"
	"path"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"pi-desk/internal/remotessh"
)

type remoteTerminalSession interface {
	Events() <-chan remotessh.RuntimeTerminalEvent
	Replay() (uint64, []byte)
	Input([]byte) error
	Resize(int, int) error
	Close() error
}

type remoteTerminalStarter interface {
	Start(context.Context, *remotessh.RuntimeLease, int, int) (remoteTerminalSession, error)
}

type runtimeTerminalStarter struct {
	runtime *remotessh.RuntimeLeaseSupervisor
}

func (starter runtimeTerminalStarter) Start(ctx context.Context, lease *remotessh.RuntimeLease, columns, rows int) (remoteTerminalSession, error) {
	return starter.runtime.StartTerminal(ctx, lease, columns, rows)
}

type remoteBinding struct {
	starter remoteTerminalStarter
	lease   *remotessh.RuntimeLease
	cwd     string
}

type remoteSession struct {
	key       string
	binding   remoteBinding
	terminal  remoteTerminalSession
	info      Snapshot
	remoteSeq uint64
	stopping  bool
}

// RemoteManager mirrors Manager's narrow lifecycle while delegating all I/O to
// one task-lease-bound remote Terminal session. It never owns or releases the
// task lease and cannot reconnect a target.
type RemoteManager struct {
	ctx     context.Context
	onEvent func(Event)

	mu             sync.Mutex
	bindings       map[string]remoteBinding
	sessions       map[string]*remoteSession
	nextGeneration uint64
	closed         bool
}

func NewRemoteManager(ctx context.Context, onEvent func(Event)) *RemoteManager {
	if ctx == nil {
		ctx = context.Background()
	}
	return &RemoteManager{ctx: ctx, onEvent: onEvent, bindings: make(map[string]remoteBinding), sessions: make(map[string]*remoteSession)}
}

func (manager *RemoteManager) Bind(threadID string, runtime *remotessh.RuntimeLeaseSupervisor, lease *remotessh.RuntimeLease, cwd string) error {
	if runtime == nil || lease == nil || lease.Kind() != remotessh.RuntimeTaskLease {
		return errors.New("remote terminal requires a task lease")
	}
	return manager.bind(threadID, runtimeTerminalStarter{runtime: runtime}, lease, cwd)
}

func (manager *RemoteManager) bind(threadID string, starter remoteTerminalStarter, lease *remotessh.RuntimeLease, cwd string) error {
	threadID, cwd = strings.TrimSpace(threadID), strings.TrimSpace(cwd)
	if threadID == "" || !validRemoteTerminalCWD(cwd) || starter == nil || lease == nil {
		return errors.New("remote terminal binding is invalid")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.closed {
		return ErrAlreadyClosed
	}
	if _, running := manager.sessions[threadID]; running {
		return ErrStopping
	}
	manager.bindings[threadID] = remoteBinding{starter: starter, lease: lease, cwd: cwd}
	return nil
}

// threadKeysLocked lists the sessions of one task. The caller holds manager.mu.
func (manager *RemoteManager) threadKeysLocked(threadID string) []string {
	keys := make([]string, 0, 1)
	for key, running := range manager.sessions {
		if running.info.ThreadID == threadID {
			keys = append(keys, key)
		}
	}
	return keys
}

func (manager *RemoteManager) Unbind(threadID string) error {
	threadID = strings.TrimSpace(threadID)
	manager.mu.Lock()
	delete(manager.bindings, threadID)
	running := make([]*remoteSession, 0, 1)
	for _, key := range manager.threadKeysLocked(threadID) {
		session := manager.sessions[key]
		session.stopping = true
		running = append(running, session)
		delete(manager.sessions, key)
	}
	manager.mu.Unlock()
	var errs []error
	for _, session := range running {
		if err := session.terminal.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (manager *RemoteManager) Start(config StartConfig) (Snapshot, error) {
	if err := validateStartConfig(config); err != nil {
		return Snapshot{}, err
	}
	key := sessionKey(config.ThreadID, config.SessionID)
	manager.mu.Lock()
	if manager.closed {
		manager.mu.Unlock()
		return Snapshot{}, ErrAlreadyClosed
	}
	binding, ok := manager.bindings[strings.TrimSpace(config.ThreadID)]
	if !ok || binding.cwd != config.CWD {
		manager.mu.Unlock()
		return Snapshot{}, errors.New("remote terminal is not bound to this task workspace")
	}
	if running := manager.sessions[key]; running != nil {
		manager.mu.Unlock()
		if err := manager.Resize(config.ThreadID, config.SessionID, config.Columns, config.Rows); err != nil {
			return Snapshot{}, err
		}
		return manager.Snapshot(config.ThreadID, config.SessionID), nil
	}
	if len(manager.sessions) >= maxActiveSessions {
		manager.mu.Unlock()
		return Snapshot{}, ErrLimitReached
	}
	if len(manager.threadKeysLocked(strings.TrimSpace(config.ThreadID))) >= maxTerminalsPerThread {
		manager.mu.Unlock()
		return Snapshot{}, ErrThreadLimit
	}
	manager.mu.Unlock()

	terminal, err := binding.starter.Start(manager.ctx, binding.lease, config.Columns, config.Rows)
	if err != nil {
		return Snapshot{}, err
	}
	remoteSequence, replay := terminal.Replay()
	manager.mu.Lock()
	manager.nextGeneration++
	generation := manager.nextGeneration
	current, stillBound := manager.bindings[strings.TrimSpace(config.ThreadID)]
	if manager.closed || !stillBound || current.lease != binding.lease || current.cwd != binding.cwd || manager.sessions[key] != nil {
		manager.mu.Unlock()
		_ = terminal.Close()
		return Snapshot{}, ErrStopping
	}
	running := &remoteSession{
		key: key, binding: binding, terminal: terminal, remoteSeq: remoteSequence,
		info: Snapshot{
			ThreadID: config.ThreadID, SessionID: strings.TrimSpace(config.SessionID), CWD: binding.cwd,
			Shell: "remote shell", Running: true, Generation: generation, Sequence: remoteSequence,
			Columns: config.Columns, Rows: config.Rows, Output: boundedReplay(replay),
		},
	}
	manager.sessions[key] = running
	snapshot := cloneSnapshot(running.info)
	manager.mu.Unlock()
	go manager.consume(running)
	return snapshot, nil
}

func (manager *RemoteManager) Snapshot(threadID, sessionID string) Snapshot {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if running := manager.sessions[sessionKey(threadID, sessionID)]; running != nil {
		return cloneSnapshot(running.info)
	}
	return Snapshot{ThreadID: strings.TrimSpace(threadID), SessionID: strings.TrimSpace(sessionID)}
}

func (manager *RemoteManager) Write(threadID, sessionID string, data []byte) error {
	terminal := manager.runningTerminal(threadID, sessionID)
	if terminal == nil {
		return ErrNotRunning
	}
	return terminal.Input(append([]byte(nil), data...))
}

func (manager *RemoteManager) Resize(threadID, sessionID string, columns, rows int) error {
	if err := validateDimensions(columns, rows); err != nil {
		return err
	}
	manager.mu.Lock()
	running := manager.sessions[sessionKey(threadID, sessionID)]
	manager.mu.Unlock()
	if running == nil {
		return ErrNotRunning
	}
	if err := running.terminal.Resize(columns, rows); err != nil {
		return err
	}
	// Remember the geometry the replay buffer was produced at; see session.setGeometry.
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.sessions[running.key] == running {
		running.info.Columns, running.info.Rows = columns, rows
	}
	return nil
}

func (manager *RemoteManager) Stop(threadID, sessionID string) error {
	manager.mu.Lock()
	running := manager.sessions[sessionKey(threadID, sessionID)]
	if running != nil {
		running.stopping = true
	}
	manager.mu.Unlock()
	if running == nil {
		return ErrNotRunning
	}
	return running.terminal.Close()
}

// StopThread closes every remote terminal of a task; the binding itself stays until Unbind.
func (manager *RemoteManager) StopThread(threadID string) error {
	threadID = strings.TrimSpace(threadID)
	manager.mu.Lock()
	running := make([]*remoteSession, 0, 1)
	for _, key := range manager.threadKeysLocked(threadID) {
		session := manager.sessions[key]
		session.stopping = true
		running = append(running, session)
	}
	manager.mu.Unlock()
	if len(running) == 0 {
		return ErrNotRunning
	}
	var errs []error
	for _, session := range running {
		if err := session.terminal.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (manager *RemoteManager) Shutdown() {
	manager.mu.Lock()
	if manager.closed {
		manager.mu.Unlock()
		return
	}
	manager.closed = true
	manager.bindings = make(map[string]remoteBinding)
	sessions := make([]*remoteSession, 0, len(manager.sessions))
	for _, running := range manager.sessions {
		running.stopping = true
		sessions = append(sessions, running)
	}
	manager.mu.Unlock()
	for _, running := range sessions {
		_ = running.terminal.Close()
	}
}

func (manager *RemoteManager) runningTerminal(threadID, sessionID string) remoteTerminalSession {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if running := manager.sessions[sessionKey(threadID, sessionID)]; running != nil {
		return running.terminal
	}
	return nil
}

func (manager *RemoteManager) consume(running *remoteSession) {
	terminalSeen := false
	for event := range running.terminal.Events() {
		manager.mu.Lock()
		if manager.sessions[running.key] != running {
			manager.mu.Unlock()
			return
		}
		projected := Event{ThreadID: running.info.ThreadID, SessionID: running.info.SessionID, Generation: running.info.Generation, ExitCode: event.ExitCode}
		switch event.Type {
		case "output":
			if event.Sequence <= running.remoteSeq {
				manager.mu.Unlock()
				continue
			}
			if event.Sequence != running.remoteSeq+1 {
				running.remoteSeq, running.info.Output = running.terminal.Replay()
				running.info.Output = boundedReplay(running.info.Output)
				running.info.Sequence += 2 // force the frontend to hydrate the replay snapshot.
				projected.Type = "output"
			} else {
				running.remoteSeq = event.Sequence
				running.info.Output = appendReplay(running.info.Output, event.Data)
				running.info.Sequence++
				projected.Type, projected.Data = "output", append([]byte(nil), event.Data...)
			}
		case "exit":
			terminalSeen = true
			running.info.Running = false
			running.info.Sequence++
			delete(manager.sessions, running.key)
			projected.Type, projected.Error = "exit", boundedTerminalError(event.Error)
		case "disconnected":
			terminalSeen = true
			running.info.Running = false
			running.info.Sequence++
			delete(manager.sessions, running.key)
			projected.Type, projected.ExitCode, projected.Error = "exit", -1, boundedTerminalError(event.Error)
		default:
			manager.mu.Unlock()
			continue
		}
		projected.Sequence = running.info.Sequence
		manager.mu.Unlock()
		manager.emit(projected)
	}
	manager.mu.Lock()
	if manager.sessions[running.key] == running {
		delete(manager.sessions, running.key)
	}
	if !terminalSeen {
		running.info.Running = false
		running.info.Sequence++
		sequence := running.info.Sequence
		manager.mu.Unlock()
		manager.emit(Event{ThreadID: running.info.ThreadID, SessionID: running.info.SessionID, Type: "exit", Generation: running.info.Generation, Sequence: sequence, ExitCode: -1, Error: "REMOTE_DISCONNECTED: remote terminal disconnected"})
		return
	}
	manager.mu.Unlock()
}

func (manager *RemoteManager) emit(event Event) {
	if manager.onEvent != nil {
		manager.onEvent(event)
	}
}

func cloneSnapshot(snapshot Snapshot) Snapshot {
	snapshot.Output = append([]byte(nil), snapshot.Output...)
	return snapshot
}

func appendReplay(replay, data []byte) []byte {
	if len(data) >= maxReplayBytes {
		return append(replay[:0], data[len(data)-maxReplayBytes:]...)
	}
	if overflow := len(replay) + len(data) - maxReplayBytes; overflow > 0 {
		copy(replay, replay[overflow:])
		replay = replay[:len(replay)-overflow]
	}
	return append(replay, data...)
}

func boundedReplay(replay []byte) []byte {
	if len(replay) > maxReplayBytes {
		replay = replay[len(replay)-maxReplayBytes:]
	}
	return append([]byte(nil), replay...)
}

func validRemoteTerminalCWD(value string) bool {
	if value == "" || len(value) > 4096 || !utf8.ValidString(value) || !path.IsAbs(value) || path.Clean(value) != value || strings.Contains(value, "\\") {
		return false
	}
	for _, char := range value {
		if char == 0 || unicode.IsControl(char) || unicode.Is(unicode.Cf, char) {
			return false
		}
	}
	return true
}

func boundedTerminalError(err error) string {
	if err == nil {
		return ""
	}
	value := err.Error()
	if len(value) > 2048 {
		value = value[:2048]
	}
	return value
}
