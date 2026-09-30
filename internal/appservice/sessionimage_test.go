package appservice

import (
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"encoding/json"
	"strings"

	"pi-desk/internal/sessionindex"
)

type stubImageSource struct {
	image sessionindex.ImageData
	err   error
	refs  []string
	// A reference this fake "minted", plus the session file it names.
	transcriptRef  string
	transcriptPath string
}

// A transcript stub: the route only ever resolves a reference this process minted, so the test
// hands back whatever path the fake decides is current and the snapshot the caller asked for.
func (source *stubImageSource) ResolveTranscriptRef(value string) (string, error) {
	if source.transcriptRef == "" || value != source.transcriptRef {
		return "", errors.New("session reference is stale")
	}
	return source.transcriptPath, nil
}

func (source *stubImageSource) Snapshot(path string) (sessionindex.Snapshot, error) {
	if path != source.transcriptPath {
		return sessionindex.Snapshot{}, errors.New("session path is outside the configured Pi sessions directory")
	}
	return sessionindex.Snapshot{
		Messages:     []json.RawMessage{json.RawMessage(`{"role":"user","content":"hi"}`)},
		MessageCount: 1,
	}, nil
}

func (source *stubImageSource) Image(ref string) (sessionindex.ImageData, error) {
	source.refs = append(source.refs, ref)
	return source.image, source.err
}

func passthrough() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusTeapot)
		_, _ = writer.Write([]byte("frontend"))
	})
}

func TestSessionImageMiddlewareServesReferencedBytes(t *testing.T) {
	payload, err := base64.StdEncoding.DecodeString("aW1hZ2U=")
	if err != nil {
		t.Fatal(err)
	}
	source := &stubImageSource{image: sessionindex.ImageData{MIMEType: "image/png", Data: payload}}
	handler := SessionImageMiddleware(source)(passthrough())

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/session-image?ref=abc.def", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status: %d", response.Code)
	}
	if response.Body.String() != "image" {
		t.Fatalf("body: %q", response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("content type: %q", got)
	}
	// A repaint must not re-read the session file: the reference is immutable content.
	if got := response.Header().Get("Cache-Control"); got == "" {
		t.Fatal("missing cache control")
	}
	if got := response.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("missing nosniff: %q", got)
	}
	if len(source.refs) != 1 || source.refs[0] != "abc.def" {
		t.Fatalf("refs: %#v", source.refs)
	}
}

func TestSessionImageMiddlewareDegradesToNotFound(t *testing.T) {
	source := &stubImageSource{err: errors.New("unknown session image reference")}
	handler := SessionImageMiddleware(source)(passthrough())

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/session-image?ref=stale", nil))
	// A transcript can outlive the file it came from; a broken thumbnail is not a server error.
	if response.Code != http.StatusNotFound {
		t.Fatalf("status: %d", response.Code)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/session-image?ref=x", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status: %d", response.Code)
	}
}

func TestSessionImageMiddlewareLeavesEveryOtherPathAlone(t *testing.T) {
	source := &stubImageSource{}
	handler := SessionImageMiddleware(source)(passthrough())

	for _, path := range []string{"/", "/assets/app.js", "/wails/runtime", "/session-image/extra", "/session-images?ref=x", "/session-transcript/extra", "/session-transcripts?ref=x"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusTeapot {
			t.Fatalf("%s was intercepted: %d", path, response.Code)
		}
		if response.Body.String() != "frontend" {
			t.Fatalf("%s body: %q", path, response.Body.String())
		}
	}
	if len(source.refs) != 0 {
		t.Fatalf("unexpected lookups: %#v", source.refs)
	}
}

func TestSessionImageContentTypeRefusesAnythingElse(t *testing.T) {
	if got := sessionImageContentType("IMAGE/PNG"); got != "image/png" {
		t.Fatalf("content type: %q", got)
	}
	for _, value := range []string{"", "text/html", "image/svg+xml", "image/png; charset=utf-8"} {
		if got := sessionImageContentType(value); got != "application/octet-stream" {
			t.Fatalf("%q served as %q", value, got)
		}
	}
}

// The transcript route is the one carrying the payload that used to cost ~300ms of bridge time, so
// its body has to be exactly the shape the `GetSessionSnapshot` binding returns - the frontend
// reads either transport with the same code.
func TestSessionTranscriptRouteServesTheSnapshotShape(t *testing.T) {
	source := &stubImageSource{transcriptRef: "good.sig", transcriptPath: "/sessions/project/a.jsonl"}
	handler := SessionImageMiddleware(source)(passthrough())

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/session-transcript?ref=good.sig", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status: %d body=%s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("content type: %q", got)
	}
	// The reference pins mtime+size, so this URL can never mean a different transcript: caching it
	// is what makes re-opening an idle task free.
	if got := response.Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Fatalf("cache-control: %q", got)
	}
	if got := response.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("nosniff: %q", got)
	}

	var decoded struct {
		Messages     []json.RawMessage `json:"messages"`
		MessageCount int               `json:"messageCount"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("body is not the snapshot shape: %v (%s)", err, response.Body.String())
	}
	if decoded.MessageCount != 1 || len(decoded.Messages) != 1 {
		t.Fatalf("decoded = %+v", decoded)
	}

	// HEAD carries the length but no body, so a probe costs what it says it costs.
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodHead, "/session-transcript?ref=good.sig", nil))
	if response.Code != http.StatusOK || response.Body.Len() != 0 {
		t.Fatalf("HEAD: %d body=%d", response.Code, response.Body.Len())
	}
	if response.Header().Get("Content-Length") == "" {
		t.Fatal("HEAD lost Content-Length")
	}
}

// A stale or forged reference is answered as "not available" and never as a transcript: the session
// has moved on, and the caller either mints a fresh reference or takes the bridge.
func TestSessionTranscriptRouteDegradesToNotFound(t *testing.T) {
	source := &stubImageSource{transcriptRef: "good.sig", transcriptPath: "/sessions/project/a.jsonl"}
	handler := SessionImageMiddleware(source)(passthrough())

	for _, query := range []string{"ref=", "ref=forged.sig", "ref=good.si"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/session-transcript?"+query, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s: status %d", query, response.Code)
		}
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/session-transcript?ref=good.sig", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: status %d", response.Code)
	}
}
