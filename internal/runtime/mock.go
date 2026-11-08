package runtime

import (
	"context"
	"sync"

	"pi-desk/internal/pirpc"
	"pi-desk/internal/piruntime"
)

// Mock is a deterministic Runtime for tests. It never spawns a process.
type Mock struct {
	mu       sync.Mutex
	info     Info
	sessions map[string]piruntime.SessionInfo
	commands []map[string]any
	next     uint64
	closed   bool
}

func NewMock() *Mock {
	return &Mock{
		info: Info{
			ID: "mock", Name: "Mock",
			Capabilities: Capabilities{Streaming: true, SessionResume: true},
		},
		sessions: make(map[string]piruntime.SessionInfo),
	}
}

func (mock *Mock) Info() Info {
	return mock.info
}

func (mock *Mock) Start(_ context.Context, config piruntime.StartConfig) (piruntime.SessionInfo, error) {
	mock.mu.Lock()
	defer mock.mu.Unlock()
	mock.next++
	info := piruntime.SessionInfo{ThreadID: config.ThreadID, Generation: mock.next}
	mock.sessions[config.ThreadID] = info
	return info, nil
}

func (mock *Mock) Call(_ context.Context, sessionID string, command map[string]any) (pirpc.Response, error) {
	mock.mu.Lock()
	defer mock.mu.Unlock()
	mock.commands = append(mock.commands, command)
	return pirpc.Response{Type: "response", Command: commandType(command), Success: true}, nil
}

func (mock *Mock) Send(sessionID string, command map[string]any) error {
	mock.mu.Lock()
	defer mock.mu.Unlock()
	mock.commands = append(mock.commands, command)
	return nil
}

func (mock *Mock) Stop(sessionID string) error {
	mock.mu.Lock()
	defer mock.mu.Unlock()
	delete(mock.sessions, sessionID)
	return nil
}

func (mock *Mock) Diagnostics(string) (string, error) {
	return "mock", nil
}

func (mock *Mock) ActiveCount() int {
	mock.mu.Lock()
	defer mock.mu.Unlock()
	return len(mock.sessions)
}

func (mock *Mock) StopAll() error {
	mock.mu.Lock()
	defer mock.mu.Unlock()
	mock.sessions = make(map[string]piruntime.SessionInfo)
	return nil
}

func (mock *Mock) Shutdown() {
	mock.mu.Lock()
	defer mock.mu.Unlock()
	mock.closed = true
	mock.sessions = make(map[string]piruntime.SessionInfo)
}

func (mock *Mock) Commands() []map[string]any {
	mock.mu.Lock()
	defer mock.mu.Unlock()
	result := make([]map[string]any, len(mock.commands))
	copy(result, mock.commands)
	return result
}

func (mock *Mock) Closed() bool {
	mock.mu.Lock()
	defer mock.mu.Unlock()
	return mock.closed
}

func commandType(command map[string]any) string {
	if value, ok := command["type"].(string); ok {
		return value
	}
	return ""
}

var _ Runtime = (*Mock)(nil)
