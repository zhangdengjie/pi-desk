package appservice

import (
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"pi-desk/internal/sessionindex"
)

type stubImageSource struct {
	image sessionindex.ImageData
	err   error
	refs  []string
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

	for _, path := range []string{"/", "/assets/app.js", "/wails/runtime", "/session-image/extra", "/session-images?ref=x"} {
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