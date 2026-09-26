package domain

type StartTerminalRequest struct {
	ThreadID      string `json:"threadId"`
	SessionID     string `json:"sessionId,omitempty"`
	WorkspaceID   string `json:"workspaceId,omitempty"`
	WorkspacePath string `json:"workspacePath,omitempty"`
	Columns       int    `json:"columns"`
	Rows          int    `json:"rows"`
}

type TerminalRequest struct {
	ThreadID    string `json:"threadId"`
	SessionID   string `json:"sessionId,omitempty"`
	WorkspaceID string `json:"workspaceId,omitempty"`
}

type TerminalWriteRequest struct {
	ThreadID  string `json:"threadId"`
	SessionID string `json:"sessionId,omitempty"`
	Data      string `json:"data"`
}

type TerminalResizeRequest struct {
	ThreadID  string `json:"threadId"`
	SessionID string `json:"sessionId,omitempty"`
	Columns   int    `json:"columns"`
	Rows      int    `json:"rows"`
}

type TerminalState struct {
	ThreadID   string `json:"threadId"`
	SessionID  string `json:"sessionId,omitempty"`
	CWD        string `json:"cwd,omitempty"`
	Shell      string `json:"shell,omitempty"`
	Running    bool   `json:"running"`
	Generation uint64 `json:"generation,omitempty"`
	Sequence   uint64 `json:"sequence"`
	OutputB64  string `json:"outputB64,omitempty"`
}

type TerminalEvent struct {
	ThreadID   string `json:"threadId"`
	SessionID  string `json:"sessionId,omitempty"`
	Type       string `json:"type"`
	Generation uint64 `json:"generation,omitempty"`
	Sequence   uint64 `json:"sequence"`
	DataB64    string `json:"dataB64,omitempty"`
	ExitCode   int    `json:"exitCode,omitempty"`
	Error      string `json:"error,omitempty"`
}
