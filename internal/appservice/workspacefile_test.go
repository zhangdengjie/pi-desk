package appservice

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pi-desk/internal/workspace"
)

func localDocumentWorkspace(t *testing.T) workspace.Record {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "books"), 0o755); err != nil {
		t.Fatal(err)
	}
	pdf := append([]byte("%PDF-1.7\n"), []byte("workspace-file-test-payload")...)
	if err := os.WriteFile(filepath.Join(root, "books", "paper.pdf"), pdf, 0o644); err != nil {
		t.Fatal(err)
	}
	epub := append([]byte("PK\x03\x04"), []byte("workspace-file-test-payload")...)
	if err := os.WriteFile(filepath.Join(root, "books", "novel.epub"), epub, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "books", "notes.txt"), []byte("%PDF-1.7 not a real document"), 0o644); err != nil {
		t.Fatal(err)
	}
	return workspace.Record{
		ID: "ws-1", Path: root, Trust: "approve",
		Location: workspace.Location{Kind: workspace.KindLocal, Local: workspace.LocalLocation{CanonicalPath: root}},
	}
}

func serveWorkspaceFileRequest(source workspaceAssetSource, request *http.Request) *httptest.ResponseRecorder {
	handler := WorkspaceFileMiddleware(source)(passthrough())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestWorkspaceFileMiddlewareServesPdf(t *testing.T) {
	record := localDocumentWorkspace(t)
	response := serveWorkspaceFileRequest(workspaceImageFixture{record: record},
		httptest.NewRequest(http.MethodGet, "/workspace-file?workspaceId=ws-1&path=books%2Fpaper.pdf", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "application/pdf" {
		t.Fatalf("content type = %q", got)
	}
	if got := response.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Fatalf("accept ranges = %q", got)
	}
	if got := response.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("nosniff = %q", got)
	}
	want, err := os.ReadFile(filepath.Join(record.Path, "books", "paper.pdf"))
	if err != nil {
		t.Fatal(err)
	}
	if response.Body.String() != string(want) {
		t.Fatalf("body = %q, want %q", response.Body.String(), string(want))
	}
}

// The reader asks for one page's bytes at a time, so a route that ignored Range would still pass a
// whole-body test. This is the assertion that keeps the PDF engine from loading the entire book.
func TestWorkspaceFileMiddlewareAnswersRange(t *testing.T) {
	record := localDocumentWorkspace(t)
	request := httptest.NewRequest(http.MethodGet, "/workspace-file?workspaceId=ws-1&path=books%2Fpaper.pdf", nil)
	request.Header.Set("Range", "bytes=0-7")

	response := serveWorkspaceFileRequest(workspaceImageFixture{record: record}, request)

	if response.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", response.Code)
	}
	if got := response.Body.String(); got != "%PDF-1.7" {
		t.Fatalf("body = %q", got)
	}
	if got := response.Header().Get("Content-Range"); got != "bytes 0-7/36" {
		t.Fatalf("content range = %q", got)
	}
}

func TestWorkspaceFileMiddlewareServesEpub(t *testing.T) {
	record := localDocumentWorkspace(t)
	response := serveWorkspaceFileRequest(workspaceImageFixture{record: record},
		httptest.NewRequest(http.MethodGet, "/workspace-file?root=%2Ftmp%2Frepo&path=books%2Fnovel.epub", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "application/epub+zip" {
		t.Fatalf("content type = %q", got)
	}
}

func TestWorkspaceFileMiddlewareAnswersHeadWithoutBody(t *testing.T) {
	record := localDocumentWorkspace(t)
	response := serveWorkspaceFileRequest(workspaceImageFixture{record: record},
		httptest.NewRequest(http.MethodHead, "/workspace-file?workspaceId=ws-1&path=books%2Fpaper.pdf", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if response.Body.Len() != 0 {
		t.Fatalf("HEAD body = %q", response.Body.String())
	}
	if got := response.Header().Get("Content-Length"); got != "36" {
		t.Fatalf("content length = %q", got)
	}
}

// This route must not become a generic file reader: only the two formats the reader view renders
// from bytes are served, and the decision is the resolved path's, not the caller's.
func TestWorkspaceFileMiddlewareRefusesOtherFormats(t *testing.T) {
	record := localDocumentWorkspace(t)
	for _, path := range []string{"books%2Fnotes.txt", "books%2Fmissing.pdf", "..%2Fetc%2Fpasswd"} {
		response := serveWorkspaceFileRequest(workspaceImageFixture{record: record},
			httptest.NewRequest(http.MethodGet, "/workspace-file?workspaceId=ws-1&path="+path, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("path %q status = %d, want 404", path, response.Code)
		}
	}
}

func TestWorkspaceFileMiddlewareRefusesUntrustedOrRemoteWorkspaces(t *testing.T) {
	record := localDocumentWorkspace(t)
	denied := record
	denied.Trust = "deny"
	remote := record
	remote.Location = workspace.Location{Kind: workspace.KindSSH}

	for name, candidate := range map[string]workspace.Record{"deny": denied, "ssh": remote} {
		response := serveWorkspaceFileRequest(workspaceImageFixture{record: candidate},
			httptest.NewRequest(http.MethodGet, "/workspace-file?workspaceId=ws-1&path=books%2Fpaper.pdf", nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", name, response.Code)
		}
	}
}

func TestWorkspaceFileMiddlewareRejectsBothOrNeitherSelector(t *testing.T) {
	record := localDocumentWorkspace(t)
	for _, target := range []string{
		"/workspace-file?path=books%2Fpaper.pdf",
		"/workspace-file?workspaceId=ws-1&root=%2Ftmp%2Frepo&path=books%2Fpaper.pdf",
	} {
		response := serveWorkspaceFileRequest(workspaceImageFixture{record: record}, httptest.NewRequest(http.MethodGet, target, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("target %q status = %d, want 404", target, response.Code)
		}
	}
}

func TestWorkspaceFileMiddlewareRejectsWriteMethods(t *testing.T) {
	record := localDocumentWorkspace(t)
	response := serveWorkspaceFileRequest(workspaceImageFixture{record: record},
		httptest.NewRequest(http.MethodPost, "/workspace-file?workspaceId=ws-1&path=books%2Fpaper.pdf", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", response.Code)
	}
}

func TestWorkspaceFileMiddlewareLeavesEveryOtherPathAlone(t *testing.T) {
	record := localDocumentWorkspace(t)
	for _, path := range []string{"/", "/assets/app.js", "/wails/runtime", "/workspace-file/extra", "/workspace-files?ref=x"} {
		response := serveWorkspaceFileRequest(workspaceImageFixture{record: record}, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusTeapot || !strings.Contains(response.Body.String(), "frontend") {
			t.Fatalf("path %q status = %d body = %q", path, response.Code, response.Body.String())
		}
	}
}
