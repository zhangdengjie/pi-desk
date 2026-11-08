package eventbus

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"pi-desk/internal/pirpc"
	"pi-desk/internal/piruntime"
	"pi-desk/internal/task"
	"pi-desk/internal/usage"
)

const (
	maxQueuedEvents   = 8192
	maxDisplayPayload = 256 << 10
	maxPersistPayload = 16 << 10
	maxEventsPerRun   = 10000
	eventWriteBudget  = 5 * time.Second
	criticalQueueWait = 100 * time.Millisecond
)

// Tap is the R1a bridge: it observes the existing pi:event stream, creates
// Task/Run records, persists bounded events, and emits agent:event. It never
// blocks the Pi reader; overflow is dropped and counted.
type Tap struct {
	service *task.Service
	store   task.Store

	queue     chan piruntime.SessionEvent
	ctx       context.Context
	cancel    context.CancelFunc
	waitGroup sync.WaitGroup
	mu        sync.Mutex
	closed    bool
	emitter   func(Event)
	now       func() time.Time

	runs      map[string]task.Run
	tasks     map[string]string
	seq       map[string]uint64
	counts    map[string]int
	truncated map[string]bool
	usage     *usage.Accumulator
}

func NewTap(service *task.Service, store task.Store) *Tap {
	return &Tap{
		service:   service,
		store:     store,
		queue:     make(chan piruntime.SessionEvent, maxQueuedEvents),
		now:       time.Now,
		runs:      make(map[string]task.Run),
		tasks:     make(map[string]string),
		seq:       make(map[string]uint64),
		counts:    make(map[string]int),
		truncated: make(map[string]bool),
		usage:     usage.NewAccumulator(),
	}
}

func (tap *Tap) Start(parent context.Context) {
	tap.mu.Lock()
	if tap.ctx != nil {
		tap.mu.Unlock()
		return
	}
	tap.ctx, tap.cancel = context.WithCancel(parent)
	tap.mu.Unlock()
	tap.waitGroup.Add(1)
	go tap.loop(tap.ctx)
}

func (tap *Tap) SetEmitter(emitter func(Event)) {
	tap.mu.Lock()
	tap.emitter = emitter
	tap.mu.Unlock()
}

// Handle is safe to call from the AgentService event callback. It must never
// block; a full queue drops the event and increments the drop counter inside
// the queue select.
func (tap *Tap) Handle(sessionEvent piruntime.SessionEvent) {
	tap.mu.Lock()
	closed := tap.closed
	tap.mu.Unlock()
	if closed {
		return
	}
	select {
	case tap.queue <- sessionEvent:
		return
	default:
	}
	if criticalEvent(sessionEvent.Event.Type) {
		select {
		case tap.queue <- sessionEvent:
		case <-time.After(criticalQueueWait):
			log.Printf("eventbus: queue full, dropped critical %s for thread %s", sessionEvent.Event.Type, sessionEvent.ThreadID)
		}
		return
	}
	log.Printf("eventbus: queue full, dropped %s for thread %s", sessionEvent.Event.Type, sessionEvent.ThreadID)
}

func (tap *Tap) Close() {
	tap.mu.Lock()
	if tap.closed {
		tap.mu.Unlock()
		return
	}
	tap.closed = true
	cancel := tap.cancel
	tap.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	tap.waitGroup.Wait()
}

func (tap *Tap) loop(ctx context.Context) {
	defer tap.waitGroup.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case sessionEvent := <-tap.queue:
			tap.handle(ctx, sessionEvent)
		}
	}
}

func (tap *Tap) handle(parent context.Context, sessionEvent piruntime.SessionEvent) {
	threadID := strings.TrimSpace(sessionEvent.ThreadID)
	if threadID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(parent, eventWriteBudget)
	defer cancel()

	rawType := sessionEvent.Event.Type
	payload := rawPayload(sessionEvent.Event)

	run, taskID, ok := tap.currentRun(threadID)
	if !ok {
		// Only a real turn start opens a Run. Status events such as the session-clock
		// extension's setStatus arrive between turns; opening a Run for them leaves a
		// permanently "running" Task with no agent_start behind it.
		if rawType != "agent_start" {
			return
		}
		taskValue, started, err := tap.service.StartRunForThread(ctx, threadID, threadID, "pi")
		if err != nil {
			log.Printf("eventbus: start run for thread %s: %v", threadID, err)
			return
		}
		run = started
		taskID = taskValue.ID
		tap.runs[threadID] = run
		tap.tasks[threadID] = taskID
		seq, err := tap.store.MaxEventSeq(ctx, run.ID)
		if err != nil {
			log.Printf("eventbus: max seq for run %s: %v", run.ID, err)
		}
		count, err := tap.store.CountEvents(ctx, run.ID)
		if err != nil {
			log.Printf("eventbus: count events for run %s: %v", run.ID, err)
		}
		tap.seq[run.ID] = seq
		tap.counts[run.ID] = count
	}

	normalized := NormalizeType(rawType, payload)
	sanitized, digest, size, _, _ := sanitizePayload(payload, maxDisplayPayload)
	persisted, _, _, persistedRedacted, persistedTruncated := sanitizePayload(payload, maxPersistPayload)
	count := tap.counts[run.ID]
	if count >= maxEventsPerRun {
		if !isEssentialEvent(normalized) {
			return
		}
		if !tap.truncated[run.ID] {
			if tap.appendTruncated(ctx, run, threadID, taskID, tap.nextSeq(run.ID)) {
				tap.counts[run.ID] = count + 1
				count++
			}
			tap.truncated[run.ID] = true
		}
	}
	seq := tap.nextSeq(run.ID)
	now := tap.now().UTC()
	event := Event{
		ID:         task.NewID("evt"),
		Seq:        seq,
		Type:       normalized,
		TaskID:     taskID,
		RunID:      run.ID,
		ThreadID:   threadID,
		Session:    run.SessionPath,
		Runtime:    run.Runtime,
		Generation: sessionEvent.Event.Generation,
		Timestamp:  now.UnixMilli(),
		Payload:    append(json.RawMessage(nil), sanitized...),
		Error:      sessionEvent.Event.Error,
	}

	if err := tap.store.AppendEvent(ctx, task.Event{
		ID:            event.ID,
		RunID:         run.ID,
		Seq:           event.Seq,
		Type:          event.Type,
		Payload:       persisted,
		PayloadSHA256: digest,
		PayloadBytes:  size,
		Redacted:      persistedRedacted,
		Truncated:     persistedTruncated,
		CreatedAt:     now,
	}); err != nil {
		log.Printf("eventbus: append event %s: %v", event.Type, err)
	} else {
		tap.counts[run.ID] = count + 1
	}
	tap.emit(event)

	if rawType == "message_end" {
		if delta, ok := usage.FromMessageEnd(payload); ok {
			total := tap.usage.Add(run.ID, delta)
			if err := tap.store.UpsertUsage(ctx, total); err != nil {
				log.Printf("eventbus: upsert usage for run %s: %v", run.ID, err)
			}
		}
	}

	switch rawType {
	case "agent_settled":
		status := task.StatusCompleted
		message := ""
		if payloadBool(payload, "aborted") {
			status = task.StatusCancelled
			message = "aborted"
		}
		tap.finishRun(ctx, threadID, run.ID, status, message)
	case "runtime_exit":
		tap.finishRun(ctx, threadID, run.ID, task.StatusFailed, sessionEvent.Event.Error)
	}
}

func (tap *Tap) currentRun(threadID string) (task.Run, string, bool) {
	run, ok := tap.runs[threadID]
	if !ok {
		return task.Run{}, "", false
	}
	return run, tap.tasks[threadID], true
}

func (tap *Tap) nextSeq(runID string) uint64 {
	tap.seq[runID]++
	return tap.seq[runID]
}

func (tap *Tap) finishRun(ctx context.Context, threadID, runID string, status task.Status, message string) {
	if _, err := tap.service.FinishRun(ctx, runID, status, message); err != nil && !errors.Is(err, task.ErrInvalidTransition) {
		log.Printf("eventbus: finish run %s: %v", runID, err)
	}
	delete(tap.runs, threadID)
	delete(tap.tasks, threadID)
	delete(tap.seq, runID)
	delete(tap.counts, runID)
	delete(tap.truncated, runID)
}

func (tap *Tap) appendTruncated(ctx context.Context, run task.Run, threadID, taskID string, seq uint64) bool {
	event := Event{
		ID: task.NewID("evt"), Seq: seq, Type: "run.truncated",
		TaskID: taskID, RunID: run.ID, ThreadID: threadID, Runtime: run.Runtime,
		Timestamp: tap.now().UTC().UnixMilli(), Payload: json.RawMessage(`{"limit":10000}`),
	}
	if err := tap.store.AppendEvent(ctx, task.Event{
		ID: event.ID, RunID: event.RunID, Seq: event.Seq, Type: event.Type,
		Payload: event.Payload, PayloadBytes: len(event.Payload), CreatedAt: tap.now().UTC(),
	}); err != nil {
		log.Printf("eventbus: append truncation marker for run %s: %v", run.ID, err)
		return false
	}
	tap.emit(event)
	return true
}

func (tap *Tap) emit(event Event) {
	tap.mu.Lock()
	emitter := tap.emitter
	tap.mu.Unlock()
	if emitter != nil {
		emitter(event)
	}
}

func rawPayload(event pirpc.Event) json.RawMessage {
	if len(event.Payload) > 0 {
		return event.Payload
	}
	if strings.TrimSpace(event.Record) != "" {
		return json.RawMessage(event.Record)
	}
	return json.RawMessage(`{}`)
}

func criticalEvent(eventType string) bool {
	switch eventType {
	case "message_delta", "agent_start", "agent_end", "agent_settled", "runtime_exit",
		"tool_execution_start", "tool_execution_end":
		return true
	default:
		return false
	}
}
