package eventbus

import (
	"encoding/json"
)

// Event is the normalized envelope emitted as "agent:event" and persisted (in
// reduced form) in run_events. The raw Pi payload is intentionally not exposed
// as the stable contract.
type Event struct {
	ID         string          `json:"id"`
	Seq        uint64          `json:"seq"`
	Type       string          `json:"type"`
	TaskID     string          `json:"taskId,omitempty"`
	RunID      string          `json:"runId,omitempty"`
	ThreadID   string          `json:"threadId,omitempty"`
	Session    string          `json:"sessionPath,omitempty"`
	Runtime    string          `json:"runtime"`
	Generation uint64          `json:"generation,omitempty"`
	Timestamp  int64           `json:"ts"`
	Payload    json.RawMessage `json:"payload,omitempty"`
}
