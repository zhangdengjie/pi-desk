package eventbus

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

const DefaultMaxPayloadBytes = 16 << 10

// sanitizePayload returns a bounded, redacted JSON payload plus a hash/size of
// the full original payload. The hash is an integrity/dedupe digest, not a
// cryptographic signature.
func sanitizePayload(payload []byte, maxBytes int) (out []byte, digest string, size int, redacted, truncated bool) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxPayloadBytes
	}
	size = len(payload)
	sum := sha256.Sum256(payload)
	digest = hex.EncodeToString(sum[:])
	if len(payload) == 0 {
		return []byte("{}"), digest, 0, false, false
	}
	if cleaned, changed := redactJSON(payload); changed {
		payload = cleaned
		redacted = true
	}
	if len(payload) > maxBytes {
		preview := string(payload[:maxBytes])
		bounded, err := json.Marshal(map[string]any{"truncated": true, "preview": preview})
		if err == nil {
			return bounded, digest, size, redacted, true
		}
		return []byte(`{"truncated":true}`), digest, size, redacted, true
	}
	return payload, digest, size, redacted, false
}

func redactJSON(payload []byte) ([]byte, bool) {
	var value any
	if err := json.Unmarshal(payload, &value); err != nil {
		return payload, false
	}
	cleaned, changed := redactValue(value)
	if !changed {
		return payload, false
	}
	encoded, err := json.Marshal(cleaned)
	if err != nil {
		return payload, false
	}
	return encoded, true
}

func redactValue(value any) (any, bool) {
	switch typed := value.(type) {
	case map[string]any:
		changed := false
		for key, child := range typed {
			if sensitiveKey(key) {
				typed[key] = "[redacted]"
				changed = true
				continue
			}
			next, childChanged := redactValue(child)
			typed[key] = next
			changed = changed || childChanged
		}
		return typed, changed
	case []any:
		changed := false
		for index, child := range typed {
			next, childChanged := redactValue(child)
			typed[index] = next
			changed = changed || childChanged
		}
		return typed, changed
	default:
		return value, false
	}
}

func sensitiveKey(key string) bool {
	lower := strings.ToLower(key)
	for _, marker := range []string{"authorization", "api_key", "apikey", "token", "secret", "password"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}
