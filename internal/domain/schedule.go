package domain

// ScheduleSummary is the desktop projection of one recurring Task trigger.
type ScheduleSummary struct {
	ID            string `json:"id"`
	TaskID        string `json:"taskId"`
	Name          string `json:"name"`
	Prompt        string `json:"prompt"`
	WorkspaceID   string `json:"workspaceId"`
	ModelProvider string `json:"modelProvider,omitempty"`
	ModelID       string `json:"modelId,omitempty"`
	ModelName     string `json:"modelName,omitempty"`
	ThinkingLevel string `json:"thinkingLevel,omitempty"`
	Frequency     string `json:"frequency"`
	Time          string `json:"time,omitempty"`
	Weekday       int    `json:"weekday,omitempty"`
	RunAt         string `json:"runAt,omitempty"`
	Timezone      string `json:"timezone"`
	Enabled       bool   `json:"enabled"`
	CatchUp       bool   `json:"catchUp"`
	NextRunAt     string `json:"nextRunAt,omitempty"`
	LastRunAt     string `json:"lastRunAt,omitempty"`
	LastCatchUpAt string `json:"lastCatchUpAt,omitempty"`
	LastStatus    string `json:"lastStatus,omitempty"`
	LastError     string `json:"lastError,omitempty"`
	LastThreadID  string `json:"lastThreadId,omitempty"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
}

type ScheduleSaveRequest struct {
	ID            string `json:"id,omitempty"`
	TaskID        string `json:"taskId"`
	Name          string `json:"name"`
	Prompt        string `json:"prompt"`
	WorkspaceID   string `json:"workspaceId"`
	ModelProvider string `json:"modelProvider,omitempty"`
	ModelID       string `json:"modelId,omitempty"`
	ModelName     string `json:"modelName,omitempty"`
	ThinkingLevel string `json:"thinkingLevel,omitempty"`
	Frequency     string `json:"frequency"`
	Time          string `json:"time,omitempty"`
	Weekday       int    `json:"weekday,omitempty"`
	RunAt         string `json:"runAt,omitempty"`
	Timezone      string `json:"timezone,omitempty"`
	Enabled       bool   `json:"enabled"`
	CatchUp       bool   `json:"catchUp"`
	NextRunAt     string `json:"nextRunAt,omitempty"`
	LastThreadID  string `json:"lastThreadId,omitempty"`
}

type ScheduleIDRequest struct {
	ScheduleID string `json:"scheduleId"`
}

type ScheduleRunResult struct {
	ScheduleID  string `json:"scheduleId"`
	ThreadID    string `json:"threadId,omitempty"`
	RunID       string `json:"runId,omitempty"`
	SessionPath string `json:"sessionPath,omitempty"`
}
