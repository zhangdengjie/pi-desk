package sessionindex

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

// Transcripts travel the same way images do.
//
// The bridge is a control channel: one serialised value per message, in and out
// (`@wailsio/runtime/dist/system.js` hands it to `window.webkit.messageHandlers['external']` on
// macOS). Measured against the app's own asset server on the same bytes: 1.39MB costs 89ms over
// the bridge and 4-6ms over HTTP - so a 4.5MB transcript spends ~300ms of a 368ms first open on
// being *carried*, while `JSON.parse` of the same bytes is 9ms and the Go side that built them is
// 130ms. Carrying is the expensive part, and it is the part this removes.
//
// A transcript reference differs from an image reference in one way that matters: the file grows.
// So the payload names the file *as of one moment* - canonical path plus the modification time and
// size it had when the reference was minted. Two consequences:
//
//   - the URL is content-stable, which is what lets the response carry `immutable` and a task
//     re-opened without changes come back from the webview's own cache;
//   - a reference goes stale on its own as soon as the session writes, and resolving it then fails
//     rather than serving a transcript that is missing the newest turns. The caller mints a fresh
//     one, which is a small RPC, not a re-read of the file.
//
// The signature is the same scheme as imagerefs.go, under the same per-process key: without the
// key the only reachable paths are the ones this process handed out, and each of those is
// re-validated against the sessions root on the way back in.

// ReferenceKeyUnavailable reports that this process could not read randomness, so it cannot sign a
// reference at all. It is a degradation and not a failure: the caller keeps using the bridge.
type ReferenceKeyUnavailable struct{}

func (*ReferenceKeyUnavailable) Error() string { return "session reference key is unavailable" }

// transcriptRef is the signed payload: one file, at one moment.
type transcriptRef struct {
	Path     string `json:"p"`
	Modified int64  `json:"m"`
	Size     int64  `json:"s"`
}

// TranscriptRef mints the reference for one session file. It errors on any path this process may
// not read, and on a file that cannot be stat'ed - the caller then keeps using the bridge, which
// is a slower snapshot, not a broken one.
func (index *Index) TranscriptRef(path string) (string, error) {
	canonical, err := index.ValidatePath(path)
	if err != nil {
		return "", err
	}
	if len(index.imageKey) == 0 {
		return "", &ReferenceKeyUnavailable{}
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return "", fmt.Errorf("stat session file: %w", err)
	}
	payload, err := json.Marshal(transcriptRef{Path: canonical, Modified: info.ModTime().UnixNano(), Size: info.Size()})
	if err != nil {
		return "", fmt.Errorf("encode session reference: %w", err)
	}
	mac := hmac.New(sha256.New, index.imageKey)
	mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// ResolveTranscriptRef returns the path a reference names. It fails when the reference was not
// minted by this process, when the file it names is no longer inside the sessions root, or when
// the file has changed since the reference was minted - in that last case the caller's body would
// be a stale transcript, which is worse than an error.
func (index *Index) ResolveTranscriptRef(value string) (string, error) {
	if len(index.imageKey) == 0 {
		return "", &ReferenceKeyUnavailable{}
	}
	payloadPart, signaturePart, found := strings.Cut(strings.TrimSpace(value), ".")
	if !found {
		return "", errors.New("malformed session reference")
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadPart)
	if err != nil {
		return "", errors.New("malformed session reference")
	}
	signature, err := base64.RawURLEncoding.DecodeString(signaturePart)
	if err != nil {
		return "", errors.New("malformed session reference")
	}
	mac := hmac.New(sha256.New, index.imageKey)
	mac.Write(payload)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return "", errors.New("session reference is not one this process issued")
	}
	var ref transcriptRef
	if json.Unmarshal(payload, &ref) != nil || ref.Path == "" {
		return "", errors.New("malformed session reference")
	}
	canonical, err := index.ValidatePath(ref.Path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return "", fmt.Errorf("stat session file: %w", err)
	}
	if info.Size() != ref.Size || info.ModTime().UnixNano() != ref.Modified {
		return "", errors.New("session reference is stale")
	}
	return canonical, nil
}
