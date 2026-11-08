package eventbus

import (
	"encoding/json"
	"strings"
)

// NormalizeType maps Pi's raw event names onto the harness contract. Unknown
// events are preserved under raw.* so a Pi upgrade cannot silently disappear.
func NormalizeType(rawType string, payload json.RawMessage) string {
	switch rawType {
	case "agent_start":
		return "run.started"
	case "agent_end":
		return "run.updated"
	case "agent_settled":
		if payloadBool(payload, "aborted") {
			return "run.cancelled"
		}
		return "run.completed"
	case "runtime_exit":
		return "run.failed"
	case "message_start":
		return "message.started"
	case "message_update":
		return "message.delta"
	case "message_end":
		return "message.completed"
	case "tool_execution_start":
		return "tool.started"
	case "tool_execution_update":
		return "tool.updated"
	case "tool_execution_end":
		if payloadBool(payload, "isError") {
			return "tool.failed"
		}
		return "tool.completed"
	case "compaction_start":
		return "compaction.started"
	case "compaction_end":
		return "compaction.completed"
	case "auto_retry_start":
		return "run.retry.started"
	case "auto_retry_end":
		return "run.retry.completed"
	case "extension_ui_request":
		return "extension_ui.requested"
	case "extension_error":
		return "extension.error"
	case "protocol_error":
		return "protocol.error"
	case "queue_update":
		return "queue.updated"
	case "bash_execution_update":
		return "bash.updated"
	default:
		if rawType == "" {
			return "raw.event"
		}
		return "raw." + rawType
	}
}

func payloadBool(payload json.RawMessage, key string) bool {
	if len(payload) == 0 {
		return false
	}
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		return false
	}
	flag, _ := value[key].(bool)
	return flag
}

func isEssentialEvent(eventType string) bool {
	return strings.HasPrefix(eventType, "run.") ||
		strings.HasPrefix(eventType, "permission.") ||
		eventType == "tool.started" || eventType == "tool.completed" || eventType == "tool.failed"
}
