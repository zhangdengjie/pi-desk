package eventbus

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"pi-desk/internal/pirpc"
	"pi-desk/internal/piruntime"
	"pi-desk/internal/storage/sqlite"
	"pi-desk/internal/task"
)

func newTapFixture(t *testing.T) (*Tap, task.Store) {
	t.Helper()
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "pi-desk.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close store: %v", err)
		}
	})
	service := task.NewService(store)
	return NewTap(service, store), store
}

func handle(tap *Tap, threadID, eventType string, payload string, generation uint64) {
	tap.handle(context.Background(), piruntime.SessionEvent{
		ThreadID: threadID,
		Event: pirpc.Event{
			Generation: generation,
			Type:       eventType,
			Payload:    json.RawMessage(payload),
		},
	})
}

func TestNormalizeType(t *testing.T) {
	cases := []struct {
		raw      string
		payload  string
		expected string
	}{
		{"agent_start", `{}`, "run.started"},
		{"agent_end", `{"willRetry":true}`, "run.updated"},
		{"agent_settled", `{}`, "run.completed"},
		{"agent_settled", `{"aborted":true}`, "run.cancelled"},
		{"runtime_exit", `{}`, "run.failed"},
		{"message_update", `{}`, "message.delta"},
		{"tool_execution_end", `{"isError":true}`, "tool.failed"},
		{"tool_execution_end", `{"isError":false}`, "tool.completed"},
		{"unknown_event", `{}`, "raw.unknown_event"},
		{"", `{}`, "raw.event"},
	}
	for _, testCase := range cases {
		got := NormalizeType(testCase.raw, json.RawMessage(testCase.payload))
		if got != testCase.expected {
			t.Errorf("NormalizeType(%q) = %q, want %q", testCase.raw, got, testCase.expected)
		}
	}
}

func TestSanitizePayloadRedactsAndTruncates(t *testing.T) {
	payload := []byte(`{"apiKey":"secret","nested":{"token":"abc"},"ok":1}`)
	out, digest, size, redacted, truncated := sanitizePayload(payload, DefaultMaxPayloadBytes)
	if !redacted || truncated {
		t.Fatalf("redacted=%v truncated=%v", redacted, truncated)
	}
	if len(digest) != 64 || size != len(payload) {
		t.Fatalf("digest=%q size=%d", digest, size)
	}
	if string(out) == string(payload) {
		t.Fatal("payload was not redacted")
	}
	var decoded map[string]any
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatalf("redacted payload is not JSON: %v", err)
	}
	if decoded["apiKey"] != "[redacted]" {
		t.Fatalf("apiKey = %v", decoded["apiKey"])
	}

	large := make([]byte, DefaultMaxPayloadBytes+1024)
	for index := range large {
		large[index] = 'a'
	}
	out, _, size, _, truncated = sanitizePayload(large, DefaultMaxPayloadBytes)
	if !truncated || size != len(large) {
		t.Fatalf("truncated=%v size=%d", truncated, size)
	}
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatalf("truncated payload is not JSON: %v", err)
	}
	if decoded["truncated"] != true {
		t.Fatalf("truncated marker missing: %v", decoded)
	}
}

func TestTapPersistsRunEventsAndUsage(t *testing.T) {
	tap, store := newTapFixture(t)
	var emitted []Event
	tap.SetEmitter(func(event Event) { emitted = append(emitted, event) })
	ctx := context.Background()

	handle(tap, "thread_1", "agent_start", `{}`, 1)
	tasks, err := store.ListTasks(ctx, 10)
	if err != nil || len(tasks) != 1 {
		t.Fatalf("tasks = %+v, %v", tasks, err)
	}
	runs, err := store.ListRuns(ctx, tasks[0].ID)
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs = %+v, %v", runs, err)
	}
	runID := runs[0].ID

	handle(tap, "thread_1", "message_end", `{"message":{"provider":"openai","model":"gpt","usage":{"input":10,"output":5,"cacheRead":2,"cacheWrite":1}}}`, 1)
	handle(tap, "thread_1", "tool_execution_end", `{"toolCallId":"tool_1","toolName":"bash","isError":true}`, 1)
	handle(tap, "thread_1", "agent_settled", `{}`, 1)

	run, err := store.GetRun(ctx, runID)
	if err != nil || run.Status != task.StatusCompleted || run.FinishedAt == nil {
		t.Fatalf("run = %+v, %v", run, err)
	}
	completedTask, err := store.GetTask(ctx, run.TaskID)
	if err != nil || completedTask.Status != task.StatusCompleted || completedTask.CompletedAt == nil {
		t.Fatalf("task = %+v, %v", completedTask, err)
	}
	usage, err := store.GetUsage(ctx, runID)
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	if usage.InputTokens != 10 || usage.OutputTokens != 5 || usage.CacheReadTokens != 2 || usage.CacheWriteTokens != 1 {
		t.Fatalf("usage = %+v", usage)
	}
	events, err := store.ListEvents(ctx, runID, 0)
	if err != nil || len(events) != 4 {
		t.Fatalf("events = %d, %v", len(events), err)
	}
	types := make(map[string]bool)
	for _, event := range events {
		types[event.Type] = true
	}
	for _, expected := range []string{"run.started", "message.completed", "tool.failed", "run.completed"} {
		if !types[expected] {
			t.Errorf("missing event type %s in %v", expected, types)
		}
	}
	if len(emitted) != 4 {
		t.Fatalf("emitted = %d", len(emitted))
	}
}

func TestTapIgnoresStatusEventsBetweenRuns(t *testing.T) {
	tap, store := newTapFixture(t)
	ctx := context.Background()

	handle(tap, "thread_status", "extension_ui_request", `{"type":"extension_ui_request","method":"setStatus","statusKey":"session-clock","statusText":"21:32"}`, 1)
	tasks, err := store.ListTasks(ctx, 10)
	if err != nil || len(tasks) != 0 {
		t.Fatalf("status before a turn created tasks: %+v, %v", tasks, err)
	}

	handle(tap, "thread_status", "agent_start", `{}`, 1)
	tasks, err = store.ListTasks(ctx, 10)
	if err != nil || len(tasks) != 1 {
		t.Fatalf("agent_start should create one task: %+v, %v", tasks, err)
	}
	runs, err := store.ListRuns(ctx, tasks[0].ID)
	if err != nil || len(runs) != 1 {
		t.Fatalf("agent_start should create one run: %+v, %v", runs, err)
	}
	handle(tap, "thread_status", "extension_ui_request", `{"type":"extension_ui_request","method":"setStatus","statusKey":"session-clock","statusText":"21:33"}`, 1)
	events, err := store.ListEvents(ctx, runs[0].ID, 0)
	if err != nil || len(events) != 2 || events[1].Type != "extension_ui.requested" {
		t.Fatalf("in-run status event was not persisted: %+v, %v", events, err)
	}

	handle(tap, "thread_status", "agent_settled", `{}`, 1)
	handle(tap, "thread_status", "extension_ui_request", `{"type":"extension_ui_request","method":"setStatus","statusKey":"session-clock","statusText":"21:34"}`, 1)
	runs, err = store.ListRuns(ctx, tasks[0].ID)
	if err != nil || len(runs) != 1 || runs[0].Status != task.StatusCompleted {
		t.Fatalf("post-settle status created another run: %+v, %v", runs, err)
	}
}

func TestTapMarksRuntimeExitFailed(t *testing.T) {
	tap, store := newTapFixture(t)
	ctx := context.Background()
	handle(tap, "thread_exit", "agent_start", `{}`, 1)
	tasks, err := store.ListTasks(ctx, 10)
	if err != nil || len(tasks) != 1 {
		t.Fatalf("tasks = %+v, %v", tasks, err)
	}
	runs, err := store.ListRuns(ctx, tasks[0].ID)
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs = %+v, %v", runs, err)
	}
	tap.handle(ctx, piruntime.SessionEvent{
		ThreadID: "thread_exit",
		Event:    pirpc.Event{Type: "runtime_exit", Error: "boom"},
	})
	run, err := store.GetRun(ctx, runs[0].ID)
	if err != nil || run.Status != task.StatusFailed || run.Error != "boom" {
		t.Fatalf("run = %+v, %v", run, err)
	}
}

func TestTapTruncationMarker(t *testing.T) {
	tap, store := newTapFixture(t)
	ctx := context.Background()
	handle(tap, "thread_truncate", "agent_start", `{}`, 1)
	tasks, err := store.ListTasks(ctx, 10)
	if err != nil || len(tasks) != 1 {
		t.Fatalf("tasks = %+v, %v", tasks, err)
	}
	runs, err := store.ListRuns(ctx, tasks[0].ID)
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs = %+v, %v", runs, err)
	}
	runID := runs[0].ID
	tap.counts[runID] = maxEventsPerRun
	handle(tap, "thread_truncate", "tool_execution_update", `{}`, 1)
	if count, _ := store.CountEvents(ctx, runID); count != 1 {
		t.Fatalf("non-essential event was not dropped: count=%d", count)
	}
	handle(tap, "thread_truncate", "agent_settled", `{}`, 1)
	events, err := store.ListEvents(ctx, runID, 0)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	found := false
	for _, event := range events {
		if event.Type == "run.truncated" {
			found = true
		}
	}
	if !found {
		t.Fatalf("run.truncated missing: %+v", events)
	}
}
