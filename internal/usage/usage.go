package usage

import (
	"encoding/json"
	"sync"
	"time"

	"pi-desk/internal/task"
)

// Delta is one message-level usage observation.
type Delta struct {
	Provider     string
	Model        string
	InputTokens  int64
	OutputTokens int64
	CacheRead    int64
	CacheWrite   int64
}

// FromMessageEnd extracts usage from Pi's message_end payload:
//
//	{"message": {"provider": "...", "model": "...", "usage": {"input": 1, ...}}}
func FromMessageEnd(payload json.RawMessage) (Delta, bool) {
	var envelope struct {
		Message struct {
			Provider string `json:"provider"`
			Model    string `json:"model"`
			Usage    struct {
				Input      int64 `json:"input"`
				Output     int64 `json:"output"`
				CacheRead  int64 `json:"cacheRead"`
				CacheWrite int64 `json:"cacheWrite"`
			} `json:"usage"`
		} `json:"message"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return Delta{}, false
	}
	delta := Delta{
		Provider:     envelope.Message.Provider,
		Model:        envelope.Message.Model,
		InputTokens:  envelope.Message.Usage.Input,
		OutputTokens: envelope.Message.Usage.Output,
		CacheRead:    envelope.Message.Usage.CacheRead,
		CacheWrite:   envelope.Message.Usage.CacheWrite,
	}
	if delta.InputTokens == 0 && delta.OutputTokens == 0 && delta.CacheRead == 0 && delta.CacheWrite == 0 {
		return Delta{}, false
	}
	return delta, true
}

// Accumulator sums message-level usage into one per-Run aggregate.
type Accumulator struct {
	mu     sync.Mutex
	totals map[string]task.Usage
	now    func() time.Time
}

func NewAccumulator() *Accumulator {
	return &Accumulator{totals: make(map[string]task.Usage), now: time.Now}
}

func (accumulator *Accumulator) Add(runID string, delta Delta) task.Usage {
	accumulator.mu.Lock()
	defer accumulator.mu.Unlock()
	total := accumulator.totals[runID]
	if total.ID == "" {
		total = task.Usage{
			ID:        "usage_" + runID,
			RunID:     runID,
			CreatedAt: accumulator.now().UTC(),
		}
	}
	if delta.Provider != "" {
		total.Provider = delta.Provider
	}
	if delta.Model != "" {
		total.Model = delta.Model
	}
	total.InputTokens += delta.InputTokens
	total.OutputTokens += delta.OutputTokens
	total.CacheReadTokens += delta.CacheRead
	total.CacheWriteTokens += delta.CacheWrite
	accumulator.totals[runID] = total
	return total
}

func (accumulator *Accumulator) Get(runID string) (task.Usage, bool) {
	accumulator.mu.Lock()
	defer accumulator.mu.Unlock()
	total, ok := accumulator.totals[runID]
	return total, ok
}
