package domain

// UserConfigView is the resolved content of the user's hand-editable config file.
//
// The path travels with the value on purpose: the settings dialog shows and opens
// exactly the file that was read, which may be the one PI_DESK_CONFIG or
// PI_DESK_DATA_DIR pointed at instead of ~/.pi-desk.
type UserConfigView struct {
	Path string `json:"path"`
	// StreamPanels is "auto", "alwaysOpen" or "alwaysClosed". See userconfig.
	StreamPanels string `json:"streamPanels"`
	// Error reports an unreadable or unparsable file. The value above is then the
	// default, because a broken config must never block the UI.
	Error string `json:"error,omitempty"`
}
