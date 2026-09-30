package appservice

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"pi-desk/internal/sessionindex"
)

// sessionImagePrefix is the one path the asset server answers itself instead of handing to the
// frontend. The webview loads session images from here, the same way a browser loads any other
// image: no base64 in the transcript payload, no data URL built in JS, and the bytes are read from
// disk only when something is actually displaying them.
const sessionImagePrefix = "/session-image"

// sessionTranscriptPrefix answers the whole transcript as a JSON body. The bridge is a control
// channel (one serialised value per message), and carrying 4.5MB across it measured ~300ms of a
// 368ms first open - against 4-6ms for the same bytes over this server, 130ms for the Go that built
// them and 9ms for `JSON.parse`. See `internal/sessionindex/transcriptrefs.go`.
const sessionTranscriptPrefix = "/session-transcript"

// sessionAssetSource is the narrow half of the session index these two routes need. Keeping it an
// interface means the handlers can be tested without a sessions directory on disk.
type sessionAssetSource interface {
	Image(ref string) (sessionindex.ImageData, error)
	ResolveTranscriptRef(value string) (string, error)
	Snapshot(path string) (sessionindex.Snapshot, error)
}

// SessionImageMiddleware routes `/session-image?ref=…` to the session index and passes everything
// else through untouched. Wails runs it before the rest of the asset chain, so it must be a
// pass-through for every other path - the frontend, the `/wails/` runtime endpoints and the
// dev-server proxy all travel through the same handler.
func SessionImageMiddleware(source sessionAssetSource) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			switch request.URL.Path {
			case sessionImagePrefix:
				serveSessionImage(writer, request, source)
			case sessionTranscriptPrefix:
				serveSessionTranscript(writer, request, source)
			default:
				next.ServeHTTP(writer, request)
			}
		})
	}
}

// serveSessionTranscript answers `GET /session-transcript?ref=…` with the same JSON shape the
// `GetSessionSnapshot` binding returns, so the frontend can take either without a second model.
func serveSessionTranscript(writer http.ResponseWriter, request *http.Request, source sessionAssetSource) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.Header().Set("Allow", "GET, HEAD")
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path, err := source.ResolveTranscriptRef(request.URL.Query().Get("ref"))
	if err == nil {
		var snapshot sessionindex.Snapshot
		if snapshot, err = source.Snapshot(path); err == nil {
			writeTranscriptBody(writer, request, snapshot)
			return
		}
	}
	// A stale reference is the ordinary case - the session wrote a new turn - and the caller then
	// mints a fresh one or falls back to the bridge. 404 keeps that branch boring on purpose.
	http.Error(writer, "session transcript not available", http.StatusNotFound)
}

func writeTranscriptBody(writer http.ResponseWriter, request *http.Request, snapshot sessionindex.Snapshot) {
	body, err := json.Marshal(snapshotResult(snapshot))
	if err != nil {
		http.Error(writer, "encode session transcript", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	// The reference names the file at one mtime and size, so this URL can never mean a different
	// transcript. Do not bank on the caching though: measured in the dev instance, a second fetch of
	// the same reference took 327ms (WKWebView does not appear to serve `wails://` responses from the
	// HTTP cache), so this header is a correctness statement, not the reason the route is faster.
	writer.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
	writer.WriteHeader(http.StatusOK)
	if request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write(body)
}

func serveSessionImage(writer http.ResponseWriter, request *http.Request, source sessionAssetSource) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.Header().Set("Allow", "GET, HEAD")
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// A reference is either something this process minted or it is nothing: a forged or stale one is
	// answered as "not found" rather than "forbidden", so a transcript that outlived its session
	// file shows a broken thumbnail instead of an error the reader cannot act on.
	image, err := source.Image(request.URL.Query().Get("ref"))
	if err != nil {
		http.Error(writer, "session image not available", http.StatusNotFound)
		return
	}
	writer.Header().Set("Content-Type", sessionImageContentType(image.MIMEType))
	// Refs are content-stable (session entry + position), so the webview may keep them: scrolling a
	// long transcript back and forth must not re-read the session file per repaint.
	writer.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	// Nothing here is sniffed or executed; the mime type comes from the transcript we wrote.
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Content-Length", strconv.Itoa(len(image.Data)))
	writer.WriteHeader(http.StatusOK)
	if request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write(image.Data)
}

func sessionImageContentType(mimeType string) string {
	switch strings.ToLower(strings.TrimSpace(mimeType)) {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return strings.ToLower(strings.TrimSpace(mimeType))
	default:
		return "application/octet-stream"
	}
}
