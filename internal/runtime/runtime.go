package runtime

import (
	"context"
	"encoding/json"

	"pi-desk/internal/pirpc"
	"pi-desk/internal/piruntime"
)

// Capabilities is the contract the UI uses to decide which controls to show.
// A missing capability must never be simulated by the host.
type Capabilities struct {
	Streaming      bool
	SessionResume  bool
	SessionFork    bool
	SessionBranch  bool
	Compaction     bool
	ToolApproval   bool
	ExtensionUI    bool
	SubAgent       bool
	NativeMCP      bool
	ThinkingStream bool
}

type Info struct {
	ID           string
	Name         string
	Version      string
	Capabilities Capabilities
}

// Backend is the lifecycle/control surface already implemented by
// piruntime.Supervisor and the remote Pi runtime. Keeping it small lets the
// Pi adapter wrap the existing code instead of reimplementing it.
type Backend interface {
	Start(context.Context, piruntime.StartConfig) (piruntime.SessionInfo, error)
	Call(context.Context, string, map[string]any) (pirpc.Response, error)
	Send(string, map[string]any) error
	Stop(string) error
	Diagnostics(string) (string, error)
	ActiveCount() int
	StopAll() error
	Shutdown()
}

type Runtime interface {
	Info() Info
	Backend
}

type PromptRequest struct {
	Message           string
	StreamingBehavior string
	Images            json.RawMessage
}

// Optional capabilities. Callers type-assert before showing the UI entry.
type Prompter interface {
	Prompt(ctx context.Context, sessionID string, request PromptRequest) error
}

type Forker interface {
	Fork(ctx context.Context, sessionID, entryID string) error
}

type Compactor interface {
	Compact(ctx context.Context, sessionID string) error
}
