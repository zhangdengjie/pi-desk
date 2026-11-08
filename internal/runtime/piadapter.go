package runtime

import (
	"context"
	"encoding/json"
	"errors"

	"pi-desk/internal/pirpc"
	"pi-desk/internal/piruntime"
)

// PiAdapter maps Pi's existing RPC command surface onto the Runtime contract.
// It does not own a Supervisor or a process; callers pass the existing one.
type PiAdapter struct {
	backend Backend
	info    Info
}

func NewPiAdapter(backend Backend) *PiAdapter {
	return &PiAdapter{
		backend: backend,
		info: Info{
			ID:      "pi",
			Name:    "Pi",
			Version: "",
			Capabilities: Capabilities{
				Streaming: true, SessionResume: true, SessionFork: true,
				SessionBranch: true, Compaction: true, ToolApproval: true,
				ExtensionUI: true, SubAgent: true, NativeMCP: true, ThinkingStream: true,
			},
		},
	}
}

func (adapter *PiAdapter) Info() Info {
	return adapter.info
}

func (adapter *PiAdapter) Start(ctx context.Context, config piruntime.StartConfig) (piruntime.SessionInfo, error) {
	return adapter.backend.Start(ctx, config)
}

func (adapter *PiAdapter) Call(ctx context.Context, sessionID string, command map[string]any) (pirpc.Response, error) {
	return adapter.backend.Call(ctx, sessionID, command)
}

func (adapter *PiAdapter) Send(sessionID string, command map[string]any) error {
	return adapter.backend.Send(sessionID, command)
}

func (adapter *PiAdapter) Stop(sessionID string) error {
	return adapter.backend.Stop(sessionID)
}

func (adapter *PiAdapter) Diagnostics(sessionID string) (string, error) {
	return adapter.backend.Diagnostics(sessionID)
}

func (adapter *PiAdapter) ActiveCount() int {
	return adapter.backend.ActiveCount()
}

func (adapter *PiAdapter) StopAll() error {
	return adapter.backend.StopAll()
}

func (adapter *PiAdapter) Shutdown() {
	adapter.backend.Shutdown()
}

func (adapter *PiAdapter) Prompt(ctx context.Context, sessionID string, request PromptRequest) error {
	command := map[string]any{"type": "prompt", "message": request.Message}
	if request.StreamingBehavior != "" {
		command["streamingBehavior"] = request.StreamingBehavior
	}
	if len(request.Images) > 0 {
		var images any
		if err := json.Unmarshal(request.Images, &images); err != nil {
			return err
		}
		command["images"] = images
	}
	_, err := adapter.backend.Call(ctx, sessionID, command)
	return err
}

func (adapter *PiAdapter) Fork(ctx context.Context, sessionID, entryID string) error {
	if entryID == "" {
		return errors.New("entry id is required")
	}
	_, err := adapter.backend.Call(ctx, sessionID, map[string]any{"type": "fork", "entryId": entryID})
	return err
}

func (adapter *PiAdapter) Compact(ctx context.Context, sessionID string) error {
	_, err := adapter.backend.Call(ctx, sessionID, map[string]any{"type": "compact"})
	return err
}

var _ Backend = (*piruntime.Supervisor)(nil)
var _ Runtime = (*PiAdapter)(nil)
var _ Prompter = (*PiAdapter)(nil)
var _ Forker = (*PiAdapter)(nil)
var _ Compactor = (*PiAdapter)(nil)
