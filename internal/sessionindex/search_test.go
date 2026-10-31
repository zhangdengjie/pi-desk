package sessionindex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// sessionFixture writes one transcript into the <root>/<dir>/<name>.jsonl layout `sessionFiles`
// expects and returns its path.
func sessionFixture(t *testing.T, root, name string, modified time.Time, lines ...string) string {
	t.Helper()
	path := filepath.Join(root, "project", name+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	writeSession(t, path, strings.Join(lines, "\n")+"\n")
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSearchSessionsFindsProseAcrossSessionsNewestFirst(t *testing.T) {
	// `canonicalRoot` resolves the /var -> /private/var link on macOS, so compare canonical paths.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	older := sessionFixture(t, root, "older", time.Now().Add(-48*time.Hour),
		`{"type":"session","version":3,"id":"older","cwd":`+quote(root)+`}`,
		`{"type":"message","id":"u","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"how do I keep the drag jitter out of the file tree"}]}}`,
	)
	newer := sessionFixture(t, root, "newer", time.Now().Add(-time.Hour),
		`{"type":"session","version":3,"id":"newer","cwd":`+quote(root)+`}`,
		`{"type":"message","id":"u","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"the Drag Jitter came back after the upgrade"}]}}`,
	)

	result, err := New(root).SearchSessions(context.Background(), "drag jitter", SearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Hits) != 2 || result.Truncated {
		t.Fatalf("unexpected result: %#v", result)
	}
	if result.Hits[0].Path != newer || result.Hits[1].Path != older {
		t.Fatalf("hits are not newest first: %#v", result.Hits)
	}
	if result.Hits[0].Role != "user" {
		t.Fatalf("role: %q", result.Hits[0].Role)
	}
	// The snippet keeps the transcript's own casing, which is what makes it recognisable.
	if !strings.Contains(result.Hits[0].Snippet, "Drag Jitter") {
		t.Fatalf("snippet lost its casing: %q", result.Hits[0].Snippet)
	}
	if strings.Contains(result.Hits[0].Snippet, "\n") {
		t.Fatalf("snippet is not single-line: %q", result.Hits[0].Snippet)
	}
}

func TestSearchSessionsIgnoresToolPayloadsAndShortQueries(t *testing.T) {
	root := t.TempDir()
	sessionFixture(t, root, "tools", time.Now(),
		`{"type":"session","version":3,"id":"tools","cwd":`+quote(root)+`}`,
		`{"type":"message","id":"u","parentId":null,"message":{"role":"assistant","content":[{"type":"tool_use","name":"read","input":{"path":"SECRET_PAYLOAD"}},{"type":"image","data":"SECRET_IMAGE"},{"type":"text","text":"nothing to see"}]}}`,
	)
	index := New(root)

	result, err := index.SearchSessions(context.Background(), "SECRET", SearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Hits) != 0 {
		t.Fatalf("tool payloads and images must not be searchable: %#v", result.Hits)
	}

	// One character is noise on a history this size; the scan must not even start.
	short, err := index.SearchSessions(context.Background(), "a", SearchOptions{})
	if err != nil || len(short.Hits) != 0 {
		t.Fatalf("short query: %#v, %v", short, err)
	}
}

func TestSearchSessionsReportsTruncationInsteadOfSilence(t *testing.T) {
	root := t.TempDir()
	sessionFixture(t, root, "big", time.Now(),
		`{"type":"session","version":3,"id":"big","cwd":`+quote(root)+`}`,
		`{"type":"message","id":"u","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"`+strings.Repeat("padding ", 500)+`needle in a haystack"}]}}`,
	)

	// Budget too small to reach the match: the answer must say "stopped early", not "nothing here".
	result, err := New(root).SearchSessions(context.Background(), "needle", SearchOptions{MaxBytes: 64})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Hits) != 0 || !result.Truncated {
		t.Fatalf("expected a truncated empty result, got %#v", result)
	}

	full, err := New(root).SearchSessions(context.Background(), "needle", SearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Hits) != 1 || full.Truncated {
		t.Fatalf("expected one hit, got %#v", full)
	}
	if !strings.HasPrefix(full.Hits[0].Snippet, "…") {
		t.Fatalf("a match deep in a message should be elided on the left: %q", full.Hits[0].Snippet)
	}
}

func TestSearchSessionsStopsOnCancel(t *testing.T) {
	root := t.TempDir()
	sessionFixture(t, root, "one", time.Now(),
		`{"type":"session","version":3,"id":"one","cwd":`+quote(root)+`}`,
		`{"type":"message","id":"u","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"findme"}]}}`,
	)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := New(root).SearchSessions(ctx, "findme", SearchOptions{}); err == nil {
		t.Fatal("expected the cancelled scan to report context.Canceled")
	}
}
