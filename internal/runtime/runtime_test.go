package runtime_test

import (
	"context"
	"testing"

	"pi-desk/internal/piruntime"
	"pi-desk/internal/runtime"
)

func TestPiAdapterPromptAndCapabilities(t *testing.T) {
	mock := runtime.NewMock()
	adapter := runtime.NewPiAdapter(mock)
	ctx := context.Background()
	if err := adapter.Prompt(ctx, "thread_1", runtime.PromptRequest{
		Message: "hello", StreamingBehavior: "followUp",
	}); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	commands := mock.Commands()
	if len(commands) != 1 {
		t.Fatalf("commands = %d", len(commands))
	}
	if commands[0]["type"] != "prompt" || commands[0]["message"] != "hello" || commands[0]["streamingBehavior"] != "followUp" {
		t.Fatalf("unexpected command: %+v", commands[0])
	}
	info := adapter.Info()
	if info.ID != "pi" || !info.Capabilities.Streaming || !info.Capabilities.SessionFork {
		t.Fatalf("unexpected info: %+v", info)
	}
}

func TestPiAdapterForkAndCompact(t *testing.T) {
	mock := runtime.NewMock()
	adapter := runtime.NewPiAdapter(mock)
	ctx := context.Background()
	if err := adapter.Fork(ctx, "thread_1", "entry_1"); err != nil {
		t.Fatalf("fork: %v", err)
	}
	if err := adapter.Fork(ctx, "thread_1", ""); err == nil {
		t.Fatal("empty entry id should fail")
	}
	if err := adapter.Compact(ctx, "thread_1"); err != nil {
		t.Fatalf("compact: %v", err)
	}
	commands := mock.Commands()
	if len(commands) != 2 || commands[0]["type"] != "fork" || commands[1]["type"] != "compact" {
		t.Fatalf("unexpected commands: %+v", commands)
	}
}

func TestMockLifecycle(t *testing.T) {
	mock := runtime.NewMock()
	ctx := context.Background()
	info, err := mock.Start(ctx, piruntime.StartConfig{ThreadID: "thread_1"})
	if err != nil || info.ThreadID != "thread_1" || mock.ActiveCount() != 1 {
		t.Fatalf("start = %+v, %v, active=%d", info, err, mock.ActiveCount())
	}
	if err := mock.Stop("thread_1"); err != nil || mock.ActiveCount() != 0 {
		t.Fatalf("stop: %v, active=%d", err, mock.ActiveCount())
	}
	mock.Shutdown()
	if !mock.Closed() {
		t.Fatal("mock should be closed")
	}
	if _, ok := any(mock).(runtime.Runtime); !ok {
		t.Fatal("mock must implement Runtime")
	}
}
