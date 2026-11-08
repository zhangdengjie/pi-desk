package usage_test

import (
	"encoding/json"
	"testing"

	"pi-desk/internal/usage"
)

func TestFromMessageEnd(t *testing.T) {
	payload := json.RawMessage(`{
		"message": {
			"provider": "openai",
			"model": "gpt-5",
			"usage": {"input": 120, "output": 30, "cacheRead": 40, "cacheWrite": 5}
		}
	}`)
	delta, ok := usage.FromMessageEnd(payload)
	if !ok {
		t.Fatal("expected usage")
	}
	if delta.Provider != "openai" || delta.Model != "gpt-5" {
		t.Fatalf("unexpected provider/model: %+v", delta)
	}
	if delta.InputTokens != 120 || delta.OutputTokens != 30 || delta.CacheRead != 40 || delta.CacheWrite != 5 {
		t.Fatalf("unexpected tokens: %+v", delta)
	}
	if _, ok := usage.FromMessageEnd(json.RawMessage(`{"message":{}}`)); ok {
		t.Fatal("empty usage should be ignored")
	}
	if _, ok := usage.FromMessageEnd(json.RawMessage(`not-json`)); ok {
		t.Fatal("invalid JSON should be ignored")
	}
}

func TestAccumulatorSumsMessages(t *testing.T) {
	accumulator := usage.NewAccumulator()
	first := accumulator.Add("run_1", usage.Delta{
		Provider: "openai", Model: "gpt", InputTokens: 10, OutputTokens: 2, CacheRead: 3, CacheWrite: 1,
	})
	if first.InputTokens != 10 {
		t.Fatalf("first total = %+v", first)
	}
	second := accumulator.Add("run_1", usage.Delta{InputTokens: 5, OutputTokens: 4})
	if second.InputTokens != 15 || second.OutputTokens != 6 || second.CacheReadTokens != 3 {
		t.Fatalf("second total = %+v", second)
	}
	if second.ID != "usage_run_1" || second.RunID != "run_1" {
		t.Fatalf("identity = %+v", second)
	}
}
