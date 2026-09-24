// Package userconfig reads the small JSON file a user edits by hand to pin
// Pi Desk's streaming behaviour, without going through the settings dialog.
//
// It is deliberately separate from state.json: that file is the app's own
// overwrite-on-save memory (internal/workspace/catalog.go) and hand-editing it
// while a second instance is running loses data. This file has exactly one
// writer - the user, plus the settings dialog - and it is re-read on demand, so
// an edit takes effect the next time the window is focused.
//
// Location: ~/.pi-desk/config.json, matching Pi's own ~/.pi convention. Two
// escapes exist for verification runs:
//
//	PI_DESK_CONFIG=/path/to/file.json   pin the exact file
//	PI_DESK_DATA_DIR=/path/to/dir       the sandbox instance keeps its own copy inside
package userconfig

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"pi-desk/internal/appdirs"
)

// FileName is the config file's name inside the configuration directory.
const FileName = "config.json"

const (
	// PathEnv pins an exact file, bypassing directory resolution.
	PathEnv = "PI_DESK_CONFIG"

	// StreamPanelsAuto is the shipped behaviour: the live reasoning and tool
	// windows open while the model has no answer on screen yet, and collapse
	// once the run settles.
	StreamPanelsAuto = "auto"
	// StreamPanelsAlwaysOpen keeps every panel of the running turn open - during
	// the whole answer and after it settles - so nothing has to be clicked again.
	StreamPanelsAlwaysOpen = "alwaysOpen"
	// StreamPanelsAlwaysClosed never opens a panel by itself; only a click does.
	StreamPanelsAlwaysClosed = "alwaysClosed"
)

// Reveal controls how streamed text is spread over animation frames. The three numbers
// together decide the pace: each frame releases `backlog / split` characters, clamped to
// [floor, ceiling].
type Reveal struct {
	// Split is the fraction of the backlog shown per frame. 5 = one fifth.
	Split int `json:"split"`
	// Floor is the smallest number of characters a frame may reveal, so a trickle of
	// text still moves instead of sitting until the backlog grows.
	Floor int `json:"floor"`
	// Ceiling caps a single frame. Without it one huge SSE chunk would land whole.
	Ceiling int `json:"ceiling"`
}

// Scroll controls how the transcript chases the streaming tail.
type Scroll struct {
	// SnapWithinPx: a jump no larger than this pins straight to the bottom; a larger
	// one is eased over frames instead of teleporting.
	SnapWithinPx int `json:"snapWithinPx"`
	// Factor is the share of the remaining distance travelled per frame while easing.
	Factor float64 `json:"factor"`
	// ResumeWithinPx: how close to a bottom the reader has to be - in the timeline or
	// inside a capped output window - for the follow to (re)arm.
	ResumeWithinPx int `json:"resumeWithinPx"`
	// LiveWindowDelayMs is how long a call must keep running before its output window
	// opens on its own; most calls finish faster than a blink and must not move the
	// transcript at all.
	LiveWindowDelayMs int `json:"liveWindowDelayMs"`
}

// Config is the file's content. Unknown keys are preserved on save so a newer
// build's settings do not vanish when an older one writes the file back.
type Config struct {
	// StreamPanels decides whether reasoning and tool-call panels open on their own.
	StreamPanels string `json:"streamPanels"`
	// Reveal tunes the text pacing.
	Reveal Reveal `json:"reveal"`
	// Scroll tunes tail following.
	Scroll Scroll `json:"scroll"`

	// notes records values that were rejected and replaced by their default.
	notes []string
	// extra holds keys this build does not know about, keyed by JSON name.
	extra map[string]json.RawMessage
}

// Defaults returns the shipped configuration.
func Defaults() Config {
	return Config{
		StreamPanels: StreamPanelsAuto,
		Reveal:       DefaultReveal(),
		Scroll:       DefaultScroll(),
	}
}

// DefaultReveal is the shipped pacing: a fifth of the backlog per frame, at least two
// characters and at most a hundred and sixty.
func DefaultReveal() Reveal { return Reveal{Split: 5, Floor: 2, Ceiling: 160} }

// DefaultScroll is the shipped tail follow: snap up to 140px, ease 35% of the rest per
// frame, re-arm within 24px of a bottom, open a slow call's window after 1200ms.
func DefaultScroll() Scroll {
	return Scroll{SnapWithinPx: 140, Factor: 0.35, ResumeWithinPx: 24, LiveWindowDelayMs: 1200}
}

// Notes lists the values that were out of range and fell back to their default.
func (config Config) Notes() []string { return config.notes }

// normalise clamps every number to a usable range and records what it replaced, so one
// typo in a hand edit cannot make the transcript stop following or dump a whole answer in
// a single frame.
func (config *Config) normalise() {
	if config.Reveal.Split < 2 || config.Reveal.Split > 1000 {
		config.note("reveal.split", config.Reveal.Split, DefaultReveal().Split)
		config.Reveal.Split = DefaultReveal().Split
	}
	if config.Reveal.Floor < 1 || config.Reveal.Floor > 500 {
		config.note("reveal.floor", config.Reveal.Floor, DefaultReveal().Floor)
		config.Reveal.Floor = DefaultReveal().Floor
	}
	if config.Reveal.Ceiling < config.Reveal.Floor || config.Reveal.Ceiling > 100000 {
		config.note("reveal.ceiling", config.Reveal.Ceiling, DefaultReveal().Ceiling)
		config.Reveal.Ceiling = DefaultReveal().Ceiling
	}
	if config.Scroll.SnapWithinPx < 1 || config.Scroll.SnapWithinPx > 10000 {
		config.note("scroll.snapWithinPx", config.Scroll.SnapWithinPx, DefaultScroll().SnapWithinPx)
		config.Scroll.SnapWithinPx = DefaultScroll().SnapWithinPx
	}
	if config.Scroll.Factor <= 0 || config.Scroll.Factor >= 1 {
		config.note("scroll.factor", config.Scroll.Factor, DefaultScroll().Factor)
		config.Scroll.Factor = DefaultScroll().Factor
	}
	if config.Scroll.ResumeWithinPx < 1 || config.Scroll.ResumeWithinPx > 2000 {
		config.note("scroll.resumeWithinPx", config.Scroll.ResumeWithinPx, DefaultScroll().ResumeWithinPx)
		config.Scroll.ResumeWithinPx = DefaultScroll().ResumeWithinPx
	}
	if config.Scroll.LiveWindowDelayMs < 0 || config.Scroll.LiveWindowDelayMs > 60000 {
		config.note("scroll.liveWindowDelayMs", config.Scroll.LiveWindowDelayMs, DefaultScroll().LiveWindowDelayMs)
		config.Scroll.LiveWindowDelayMs = DefaultScroll().LiveWindowDelayMs
	}
}

func (config *Config) note(key string, got, want any) {
	if config.notes == nil {
		config.notes = []string{}
	}
	config.notes = append(config.notes, fmt.Sprintf("%s=%v is out of range, using %v", key, got, want))
}

// Normal reports whether a raw value is one of the recognised panel modes, after
// trimming. The settings dialog uses it to reject a typo instead of writing it.
func Normal(value string) (string, bool) {
	switch strings.TrimSpace(value) {
	case "", StreamPanelsAuto:
		return StreamPanelsAuto, true
	case StreamPanelsAlwaysOpen:
		return StreamPanelsAlwaysOpen, true
	case StreamPanelsAlwaysClosed:
		return StreamPanelsAlwaysClosed, true
	default:
		return "", false
	}
}

// Path resolves the config file. PI_DESK_CONFIG wins, then the relocated data
// directory of a verification run, then ~/.pi-desk.
func Path() (string, error) {
	if pinned := appdirs.ExpandHome(strings.TrimSpace(os.Getenv(PathEnv))); pinned != "" {
		absolute, err := filepath.Abs(pinned)
		if err != nil {
			return "", fmt.Errorf("resolve %s: %w", PathEnv, err)
		}
		return absolute, nil
	}
	if appdirs.Overridden() {
		directory, err := appdirs.DataDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(directory, FileName), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		// Without a home directory the app cannot place the file where the user
		// expects it; fall back to the platform default so a read still works.
		directory, dirErr := appdirs.DataDir()
		if dirErr != nil {
			return "", dirErr
		}
		return filepath.Join(directory, FileName), nil
	}
	return filepath.Join(home, "."+appdirs.VendorDirName(), FileName), nil
}

// Load reads the file. A missing or unreadable file is not an error: the caller
// gets the defaults plus a reason, because a broken config must never block the
// UI that is waiting on bootstrap.
func Load() (Config, string, error) {
	path, err := Path()
	if err != nil {
		return Defaults(), "", err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Defaults(), path, nil
	}
	if err != nil {
		return Defaults(), path, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		// Deliberately tolerant of unknown keys: an older build must not lose a
		// newer build's settings, and must not refuse to start over one typo.
		return Defaults(), path, fmt.Errorf("parse %s: %w", path, err)
	}
	config := Defaults()
	config.extra = map[string]json.RawMessage{}
	for key, value := range fields {
		switch key {
		case "streamPanels":
			var mode string
			if err := json.Unmarshal(value, &mode); err == nil {
				if normalized, ok := Normal(mode); ok {
					config.StreamPanels = normalized
				}
			}
		case "reveal":
			if err := json.Unmarshal(value, &config.Reveal); err != nil {
				config.note("reveal", string(value), DefaultReveal())
				config.Reveal = DefaultReveal()
			}
		case "scroll":
			if err := json.Unmarshal(value, &config.Scroll); err != nil {
				config.note("scroll", string(value), DefaultScroll())
				config.Scroll = DefaultScroll()
			}
		default:
			config.extra[key] = value
		}
	}
	if config.StreamPanels == "" {
		config.StreamPanels = StreamPanelsAuto
	}
	config.normalise()
	return config, path, nil
}

// Save writes the config atomically, keeping any key this build does not model.
func Save(config Config) (string, error) {
	path, err := Path()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create configuration directory: %w", err)
	}
	fields := map[string]json.RawMessage{}
	for key, value := range config.extra {
		fields[key] = value
	}
	mode, err := json.Marshal(config.StreamPanels)
	if err != nil {
		return "", fmt.Errorf("encode stream panel mode: %w", err)
	}
	fields["streamPanels"] = mode
	reveal, err := json.Marshal(config.Reveal)
	if err != nil {
		return "", fmt.Errorf("encode reveal: %w", err)
	}
	fields["reveal"] = reveal
	scroll, err := json.Marshal(config.Scroll)
	if err != nil {
		return "", fmt.Errorf("encode scroll: %w", err)
	}
	fields["scroll"] = scroll
	// Go sorts map keys, so the layout is stable and a hand edit never shuffles.
	encoded, err := json.MarshalIndent(fields, "", "  ")
	if err != nil {
		return "", fmt.Errorf("encode configuration: %w", err)
	}
	encoded = append(encoded, '\n')
	temporary, err := os.CreateTemp(filepath.Dir(path), "."+FileName+"-")
	if err != nil {
		return "", fmt.Errorf("create temporary configuration: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()
	if _, err := temporary.Write(encoded); err != nil {
		return "", fmt.Errorf("write configuration: %w", err)
	}
	if err := temporary.Chmod(0o600); err != nil {
		return "", fmt.Errorf("set configuration permissions: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return "", fmt.Errorf("close configuration: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return "", fmt.Errorf("replace configuration: %w", err)
	}
	return path, nil
}

// Ensure creates the file with the defaults when nothing is there yet, so the
// path advertised in the settings dialog actually exists and can be opened.
// Any failure is returned for the caller to ignore: an unwritable home
// directory must not stop the app.
func Ensure() (string, error) {
	path, err := Path()
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(path); err == nil {
		return path, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return path, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return path, fmt.Errorf("create configuration directory: %w", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return path, fmt.Errorf("create configuration: %w", err)
	}
	defaults := Defaults()
	reveal, err := json.Marshal(defaults.Reveal)
	if err != nil {
		_ = file.Close()
		return path, err
	}
	scroll, err := json.Marshal(defaults.Scroll)
	if err != nil {
		_ = file.Close()
		return path, err
	}
	encoded, err := json.MarshalIndent(map[string]json.RawMessage{
		"streamPanels": json.RawMessage(`"` + StreamPanelsAuto + `"`),
		"reveal":       reveal,
		"scroll":       scroll,
	}, "", "  ")
	if err != nil {
		_ = file.Close()
		return path, err
	}
	if _, err := file.Write(append(encoded, '\n')); err != nil {
		_ = file.Close()
		return path, err
	}
	if err := file.Close(); err != nil {
		return path, err
	}
	return path, nil
}
