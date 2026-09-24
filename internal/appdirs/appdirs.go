// Package appdirs resolves the directories Pi Desk writes into.
//
// Every writable file the desktop owns hangs off one base directory, so a single
// environment variable moves the whole set. That is what makes a throwaway
// verification instance possible: without it a second process shares state.json with the
// instance the user is working in and silently drops their workspace registrations.
package appdirs

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// DataDirEnv relocates the state file, the managed browser profile and the remote anchors.
	DataDirEnv = "PI_DESK_DATA_DIR"
	// vendorDirName is the directory name used inside the user configuration directory.
	vendorDirName = "pi-desk"
	// defaultInstanceID names the flock file Wails keeps in the temp directory. It predates
	// DataDirEnv and must not change: two builds with different names could run at once.
	defaultInstanceID = "com.pidesk.desktop"
)

// DataDir returns the base directory for everything Pi Desk writes. PI_DESK_DATA_DIR wins when
// set; otherwise the platform user configuration directory keeps its historical layout.
func DataDir() (string, error) {
	if override := expandHome(strings.TrimSpace(os.Getenv(DataDirEnv))); override != "" {
		absolute, err := filepath.Abs(override)
		if err != nil {
			return "", fmt.Errorf("resolve %s: %w", DataDirEnv, err)
		}
		return absolute, nil
	}
	return defaultDataDir()
}

// StatePath is the desktop state file: workspace catalog, window bounds, preferences.
func StatePath() (string, error) {
	directory, err := DataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, "state.json"), nil
}

// BrowserProfileDir is the dedicated Chromium user data directory for the managed browser.
// On Windows it prefers LOCALAPPDATA so browser caches stay out of Roaming, unless
// PI_DESK_DATA_DIR relocates the whole set.
func BrowserProfileDir() (string, error) {
	if strings.TrimSpace(os.Getenv(DataDirEnv)) != "" {
		directory, err := DataDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(directory, "browser"), nil
	}
	base := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	if base == "" {
		config, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("resolve browser profile directory: %w", err)
		}
		base = config
	}
	return filepath.Join(base, vendorDirName, "browser"), nil
}

// InstanceIDFor names the flock file Wails keeps in the temp directory for a resolved state path.
// The default data directory keeps the historical, unsuffixed name so older and newer builds still
// block each other; a run with PI_DESK_DATA_DIR gets its own lock, keyed by the state path, so it
// can be refused by - nor refuse - the instance the user is working in. Two processes on the *same*
// data directory still block each other, which is what we want: they would share a state.json.
func InstanceIDFor(statePath string) string {
	statePath = filepath.Clean(statePath)
	if fallback, err := defaultStatePath(); err == nil && statePath == fallback {
		return defaultInstanceID
	}
	digest := sha256.Sum256([]byte(statePath))
	return defaultInstanceID + "-" + hex.EncodeToString(digest[:])[:12]
}

// Overridden reports whether PI_DESK_DATA_DIR moves Pi Desk's writable state somewhere else.
func Overridden() bool {
	return strings.TrimSpace(os.Getenv(DataDirEnv)) != ""
}

func defaultDataDir() (string, error) {
	directory, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("locate user configuration directory: %w", err)
	}
	return filepath.Join(directory, vendorDirName), nil
}

func defaultStatePath() (string, error) {
	directory, err := defaultDataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, "state.json"), nil
}

// expandHome lets a shell-free caller write "~/tmp/pi-desk-sandbox" in the environment variable.
func expandHome(path string) string {
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	if path == "~" {
		return home
	}
	return filepath.Join(home, strings.TrimPrefix(path, "~/"))
}

// VendorDirName is the directory name Pi Desk owns inside the user configuration
// directory. It is exported for the sibling config file under the home directory,
// which follows the same naming (pi itself uses ~/.pi).
func VendorDirName() string {
	return vendorDirName
}

// ExpandHome resolves a leading ~/ for callers that take paths from the
// environment, where a shell is not available to do the substitution.
func ExpandHome(path string) string {
	return expandHome(path)
}
