package domain

// TaskRequest addresses one Task.
type TaskRequest struct {
	TaskID string `json:"taskId"`
}

// TaskRunRequest addresses one Run.
type TaskRunRequest struct {
	RunID string `json:"runId"`
}

// TaskEventsRequest pages through persisted Run events.
type TaskEventsRequest struct {
	RunID    string `json:"runId"`
	AfterSeq uint64 `json:"afterSeq"`
	Limit    int    `json:"limit"`
}

// TaskSummary is the list-row projection.
type TaskSummary struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Status         string `json:"status"`
	Origin         string `json:"origin"`
	WorkspaceID    string `json:"workspaceId,omitempty"`
	Priority       int    `json:"priority"`
	LegacyThreadID string `json:"legacyThreadId,omitempty"`
	CreatedAt      int64  `json:"createdAt"`
	UpdatedAt      int64  `json:"updatedAt"`
	CompletedAt    int64  `json:"completedAt,omitempty"`
	ArchivedAt     int64  `json:"archivedAt,omitempty"`
}

// TaskRunSummary is one execution attempt. Usage is nil until a message_end
// event with token counts has been observed.
type TaskRunSummary struct {
	ID            string            `json:"id"`
	TaskID        string            `json:"taskId"`
	Runtime       string            `json:"runtime"`
	Status        string            `json:"status"`
	SessionPath   string            `json:"sessionPath,omitempty"`
	ModelProvider string            `json:"modelProvider,omitempty"`
	ModelID       string            `json:"modelId,omitempty"`
	Error         string            `json:"error,omitempty"`
	Attempt       int               `json:"attempt"`
	Generation    uint64            `json:"generation"`
	CreatedAt     int64             `json:"createdAt"`
	StartedAt     int64             `json:"startedAt,omitempty"`
	FinishedAt    int64             `json:"finishedAt,omitempty"`
	Usage         *TaskUsageSummary `json:"usage,omitempty"`
}

type TaskDetail struct {
	TaskSummary
	Runs []TaskRunSummary `json:"runs"`
}

type TaskUsageSummary struct {
	InputTokens      int64   `json:"inputTokens"`
	OutputTokens     int64   `json:"outputTokens"`
	CacheReadTokens  int64   `json:"cacheReadTokens"`
	CacheWriteTokens int64   `json:"cacheWriteTokens"`
	EstimatedCost    float64 `json:"estimatedCost"`
	CreatedAt        int64   `json:"createdAt,omitempty"`
}

type TaskEventView struct {
	ID        string `json:"id"`
	RunID     string `json:"runId"`
	Type      string `json:"type"`
	Seq       uint64 `json:"seq"`
	Payload   string `json:"payload,omitempty"`
	Redacted  bool   `json:"redacted"`
	Truncated bool   `json:"truncated"`
	CreatedAt int64  `json:"createdAt"`
}
