package appservice

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"pi-desk/internal/workspace"
)

type workspaceImageFixture struct {
	record workspace.Record
	err    error
}

func (fixture workspaceImageFixture) ResolveID(string) (workspace.Record, error) {
	return fixture.record, fixture.err
}

func (fixture workspaceImageFixture) ResolvePath(string) (workspace.Record, error) {
	return fixture.record, fixture.err
}

func localImageWorkspace(t *testing.T) workspace.Record {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	png := append([]byte("\x89PNG\r\n\x1a\n"), []byte("workspace-image-test")...)
	if err := os.WriteFile(filepath.Join(root, "docs", "pixel.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "notes.txt"), []byte("not an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	return workspace.Record{
		ID: "ws-1", Path: root, Trust: "approve",
		Location: workspace.Location{Kind: workspace.KindLocal, Local: workspace.LocalLocation{CanonicalPath: root}},
	}
}

func serveWorkspaceImageRequest(source workspaceAssetSource, target string) *httptest.ResponseRecorder {
	handler := WorkspaceImageMiddleware(source)(passthrough())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
	return response
}

func TestWorkspaceImageMiddlewareServesMarkdownImage(t *testing.T) {
	record := localImageWorkspace(t)
	response := serveWorkspaceImageRequest(workspaceImageFixture{record: record}, "/workspace-image?workspaceId=ws-1&path=docs%2Fpixel.png")

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("content type = %q", got)
	}
	if got := response.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("nosniff = %q", got)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("cache control = %q", got)
	}
	want, err := os.ReadFile(filepath.Join(record.Path, "docs", "pixel.png"))
	if err != nil {
		t.Fatal(err)
	}
	if string(response.Body.Bytes()) != string(want) {
		t.Fatalf("body = %q, want %q", response.Body.String(), string(want))
	}
}

func TestWorkspaceImageMiddlewareResolvesLegacyPathRoots(t *testing.T) {
	record := localImageWorkspace(t)
	response := serveWorkspaceImageRequest(workspaceImageFixture{record: record}, "/workspace-image?root=%2Ftmp%2Frepo&path=docs%2Fpixel.png")

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
}

func TestWorkspaceImageMiddlewareAnswersHeadWithoutBody(t *testing.T) {
	record := localImageWorkspace(t)
	handler := WorkspaceImageMiddleware(workspaceImageFixture{record: record})(passthrough())
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodHead, "/workspace-image?workspaceId=ws-1&path=docs%2Fpixel.png", nil)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Body.Len() != 0 {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Length") == "" {
		t.Fatal("HEAD response lost Content-Length")
	}
}

func TestWorkspaceImageMiddlewareRefusesEverythingElse(t *testing.T) {
	record := localImageWorkspace(t)
	denied := record
	denied.Trust = "deny"
	remote := record
	remote.Location = workspace.Location{Kind: workspace.KindSSH}
	cases := []struct {
		name   string
		source workspaceAssetSource
		target string
	}{
		{name: "unknown workspace", source: workspaceImageFixture{err: os.ErrNotExist}, target: "/workspace-image?workspaceId=ws-1&path=docs%2Fpixel.png"},
		{name: "untrusted workspace", source: workspaceImageFixture{record: denied}, target: "/workspace-image?workspaceId=ws-1&path=docs%2Fpixel.png"},
		{name: "remote workspace", source: workspaceImageFixture{record: remote}, target: "/workspace-image?workspaceId=ws-1&path=docs%2Fpixel.png"},
		{name: "missing path", source: workspaceImageFixture{record: record}, target: "/workspace-image?workspaceId=ws-1"},
		{name: "both roots", source: workspaceImageFixture{record: record}, target: "/workspace-image?workspaceId=ws-1&root=%2Ftmp&path=docs%2Fpixel.png"},
		{name: "traversal", source: workspaceImageFixture{record: record}, target: "/workspace-image?workspaceId=ws-1&path=..%2Fsecret.png"},
		{name: "non image", source: workspaceImageFixture{record: record}, target: "/workspace-image?workspaceId=ws-1&path=docs%2Fnotes.txt"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			response := serveWorkspaceImageRequest(testCase.source, testCase.target)
			if response.Code != http.StatusNotFound {
				t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
			}
		})
	}
}

func TestWorkspaceImageMiddlewareLeavesEveryOtherPathAlone(t *testing.T) {
	handler := WorkspaceImageMiddleware(workspaceImageFixture{err: os.ErrNotExist})(passthrough())
	for _, path := range []string{"/", "/assets/app.js", "/wails/runtime", "/workspace-image/extra", "/workspace-images?path=x", "/session-image?ref=x"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusTeapot {
			t.Fatalf("path %s did not pass through: status = %d", path, response.Code)
		}
	}
}
