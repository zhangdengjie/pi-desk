package domain

// RevealTuning is the text pacing the renderer uses while an answer streams in.
type RevealTuning struct {
	Split   int `json:"split"`
	Floor   int `json:"floor"`
	Ceiling int `json:"ceiling"`
}

// ScrollTuning is how the transcript chases the streaming tail, in the timeline and
// inside the capped reasoning and tool windows.
type ScrollTuning struct {
	SnapWithinPx      int     `json:"snapWithinPx"`
	Factor            float64 `json:"factor"`
	ResumeWithinPx    int     `json:"resumeWithinPx"`
	LiveWindowDelayMs int     `json:"liveWindowDelayMs"`
}

// UserConfigView is the resolved content of the user's hand-editable config file.
//
// The path travels with the value on purpose: the settings dialog shows and opens
// exactly the file that was read, which may be the one PI_DESK_CONFIG or
// PI_DESK_DATA_DIR pointed at instead of ~/.pi-desk.
type UserConfigView struct {
	Path string `json:"path"`
	// StreamPanels is "auto", "alwaysOpen" or "alwaysClosed". See userconfig.
	StreamPanels string `json:"streamPanels"`
	// Reveal and Scroll carry the tuning the renderer reads at start-up and after the
	// window regains focus, so a hand edit needs no restart.
	Reveal RevealTuning `json:"reveal"`
	Scroll ScrollTuning `json:"scroll"`
	// Error reports an unreadable or unparsable file, or values that were out of range
	// and fell back to their default. The fields above are usable either way, because a
	// broken config must never block the UI.
	Error string `json:"error,omitempty"`
}
