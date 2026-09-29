package appservice

import (
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

// sessionImageSource is the narrow half of the session index this needs. Keeping it an interface
// means the handler can be tested without a sessions directory on disk.
type sessionImageSource interface {
	Image(ref string) (sessionindex.ImageData, error)
}

// SessionImageMiddleware routes `/session-image?ref=…` to the session index and passes everything
// else through untouched. Wails runs it before the rest of the asset chain, so it must be a
// pass-through for every other path - the frontend, the `/wails/` runtime endpoints and the
// dev-server proxy all travel through the same handler.
func SessionImageMiddleware(source sessionImageSource) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path != sessionImagePrefix {
				next.ServeHTTP(writer, request)
				return
			}
			serveSessionImage(writer, request, source)
		})
	}
}

func serveSessionImage(writer http.ResponseWriter, request *http.Request, source sessionImageSource) {
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