package sessionindex

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// flip changes the first character so the payload and its signature no longer agree, without
// changing the length - the closest cheap stand-in for "someone edited one byte".
func flip(value string) string {
	if value == "" {
		return "x"
	}
	if value[0] == 'a' {
		return "b" + value[1:]
	}
	return "a" + value[1:]
}

// The reference is what lets the webview carry a transcript over HTTP instead of over the bridge,
// so the three things that must hold are: it resolves back to the file it named, it cannot be
// edited into reading some other file, and it stops working once the file has moved on.
func TestTranscriptRefRoundTrip(t *testing.T) {
	index, path := imageSession(t, imageSessionLines()...)

	ref, err := index.TranscriptRef(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ref, ".") {
		t.Fatalf("a reference is payload.signature: %q", ref)
	}

	resolved, err := index.ResolveTranscriptRef(ref)
	if err != nil {
		t.Fatal(err)
	}
	if resolved != path {
		t.Fatalf("resolved %q, want %q", resolved, path)
	}
	snapshot, err := index.Snapshot(resolved)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.MessageCount != 3 {
		t.Fatalf("MessageCount = %d, want 3", snapshot.MessageCount)
	}
}

// Minting and resolving both go through ValidatePath, so a reference can never be aimed at a file
// outside the sessions directory - not by the caller, and not by whoever edits the payload.
func TestTranscriptRefRejectsPathsOutsideTheRoot(t *testing.T) {
	index, _ := imageSession(t, imageSessionLines()...)
	// A sibling directory that is not the sessions root, holding a perfectly valid session file:
	// being readable is not the same as being referencable.
	directory := t.TempDir()
	outside := filepath.Join(directory, "elsewhere.jsonl")
	if err := os.WriteFile(outside, []byte(strings.Join(imageSessionLines(), "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := index.TranscriptRef(outside); err == nil {
		t.Fatal("a session outside the root minted a reference")
	} else if !strings.Contains(err.Error(), "outside the configured Pi sessions directory") {
		t.Fatalf("err = %v", err)
	}
}

func TestTranscriptRefRejectsTampering(t *testing.T) {
	index, path := imageSession(t, imageSessionLines()...)
	ref, err := index.TranscriptRef(path)
	if err != nil {
		t.Fatal(err)
	}

	for _, testCase := range []struct {
		name   string
		mutate func(string) string
	}{
		{"swapped signature", func(value string) string {
			payload, signature, _ := strings.Cut(value, ".")
			return payload + "." + flip(signature)
		}},
		{"edited payload", func(value string) string {
			payload, signature, _ := strings.Cut(value, ".")
			return flip(payload) + "." + signature
		}},
		{"no separator", func(value string) string { return strings.ReplaceAll(value, ".", "") }},
		{"empty", func(string) string { return "" }},
	} {
		if _, err := index.ResolveTranscriptRef(testCase.mutate(ref)); err == nil {
			t.Errorf("%s: tampered reference resolved", testCase.name)
		}
	}
}

// The file growing is the whole reason the payload carries mtime and size: a session that wrote a
// new turn must not be served from a reference minted before it.
func TestTranscriptRefGoesStaleWhenTheSessionWrites(t *testing.T) {
	index, path := imageSession(t, imageSessionLines()...)
	ref, err := index.TranscriptRef(path)
	if err != nil {
		t.Fatal(err)
	}

	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err = file.WriteString("{\"type\":\"message\",\"id\":\"m5\",\"parentId\":\"m3\",\"timestamp\":\"2026-09-27T23:15:00Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"and now?\"}],\"timestamp\":5}}\n"); err != nil {
		t.Fatal(err)
	}

	if _, err := index.ResolveTranscriptRef(ref); err == nil {
		t.Fatal("a stale reference still resolved")
	} else if !strings.Contains(err.Error(), "stale") {
		t.Fatalf("err = %v", err)
	}

	fresh, err := index.TranscriptRef(path)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := index.ResolveTranscriptRef(fresh)
	if err != nil {
		t.Fatalf("a freshly minted reference failed: %v", err)
	}
	if snapshot, err := index.Snapshot(resolved); err != nil || snapshot.MessageCount != 4 {
		t.Fatalf("snapshot = %+v, err = %v", snapshot, err)
	}
}

// A process that cannot read randomness serves transcripts over the bridge instead; that is a
// slower snapshot, not a broken one, so the caller must be able to tell this case apart.
func TestTranscriptRefWithoutAKey(t *testing.T) {
	index, path := imageSession(t, imageSessionLines()...)
	keyless := &Index{root: index.root}

	_, err := keyless.TranscriptRef(path)
	if !errors.As(err, new(*ReferenceKeyUnavailable)) {
		t.Fatalf("err = %v, want ReferenceKeyUnavailable", err)
	}
	if _, err := keyless.ResolveTranscriptRef("whatever.signature"); err == nil {
		t.Fatal("a keyless process resolved a reference")
	}
}
