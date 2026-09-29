package sessionindex

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A session with two images - one in a user message, one in a tool result - is the shape the
// problem was measured on: 94% of an 11.7MB payload was image base64.
func imageSession(t *testing.T, contents ...string) (*Index, string) {
	t.Helper()
	root := t.TempDir()
	directory := filepath.Join(root, "sessions", "project")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "images.jsonl")
	writeSession(t, path, strings.Join(contents, "\n")+"\n")
	return New(filepath.Join(root, "sessions")), canonicalTestPath(t, path)
}

func imageSessionLines() []string {
	return []string{
		`{"type":"session","version":3,"id":"session-images","timestamp":"2026-09-27T23:11:23Z","cwd":"/repo"}`,
		`{"type":"message","id":"m1","parentId":"session-images","timestamp":"2026-09-27T23:12:00Z","message":{"role":"user","content":[{"type":"text","text":"look"},{"type":"image","data":"aW1hZ2U=","mimeType":"image/png"}],"timestamp":1}}`,
		`{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-09-27T23:13:00Z","message":{"role":"toolResult","toolCallId":"t1","content":[{"type":"text","text":"shot"},{"type":"image","data":"c2hvdA==","mimeType":"image/jpeg"}],"timestamp":2}}`,
		`{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-09-27T23:14:00Z","message":{"role":"assistant","provider":"bailian","model":"qwen3.8-flash","content":[{"type":"text","text":"done"}],"timestamp":3}}`,
	}
}

func imageBlock(t *testing.T, message json.RawMessage, position int) map[string]any {
	t.Helper()
	var envelope struct {
		Content []map[string]any `json:"content"`
	}
	if err := json.Unmarshal(message, &envelope); err != nil {
		t.Fatal(err)
	}
	if position >= len(envelope.Content) {
		t.Fatalf("message has no content block %d: %s", position, message)
	}
	return envelope.Content[position]
}

func TestSnapshotReplacesImageBytesWithAReference(t *testing.T) {
	index, path := imageSession(t, imageSessionLines()...)

	snapshot, err := index.Snapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Messages) != 3 {
		t.Fatalf("unexpected messages: %d", len(snapshot.Messages))
	}
	// The count and the model travel in the same pass the messages do.
	if snapshot.MessageCount != 3 || snapshot.Model == nil || snapshot.Model.ID != "qwen3.8-flash" {
		t.Fatalf("unexpected snapshot summary: %#v", snapshot)
	}
	for _, message := range snapshot.Messages {
		if strings.Contains(string(message), `"data"`) || strings.Contains(string(message), "aW1hZ2U=") || strings.Contains(string(message), "c2hvdA==") {
			t.Fatalf("image bytes stayed in the snapshot: %s", message)
		}
		if strings.Contains(string(message), `"t1"`) {
			// The tool result is the one that must keep its identity while losing its bytes.
			block := imageBlock(t, message, 1)
			if block["type"] != "image" || block["mimeType"] != "image/jpeg" || block["bytes"] != float64(4) {
				t.Fatalf("unexpected image block: %#v", block)
			}
			if ref, ok := block["ref"].(string); !ok || ref == "" {
				t.Fatalf("image block has no reference: %#v", block)
			}
		}
	}

	userImage := imageBlock(t, snapshot.Messages[0], 1)
	image, err := index.Image(userImage["ref"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if image.MIMEType != "image/png" || string(image.Data) != "image" {
		t.Fatalf("unexpected image: %#v", image)
	}
}

func TestSnapshotKeepsTextOnlyMessagesByteForByte(t *testing.T) {
	index, path := imageSession(t, imageSessionLines()...)
	snapshot, err := index.Snapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(snapshot.Messages[2]), `"provider":"bailian"`) {
		t.Fatalf("text message lost a field: %s", snapshot.Messages[2])
	}
	message, changed, err := index.stripImageData(json.RawMessage(`{"role":"assistant","content":"done"}`), path, "m3")
	if err != nil || changed {
		t.Fatalf("a message without image blocks was rewritten: %v %v %s", changed, err, message)
	}
	if string(message) != `{"role":"assistant","content":"done"}` {
		t.Fatalf("unexpected rewrite: %s", message)
	}
}

func TestImageReferenceCannotBeForgedOrReusedAcrossProcesses(t *testing.T) {
	index, path := imageSession(t, imageSessionLines()...)
	snapshot, err := index.Snapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	ref := imageBlock(t, snapshot.Messages[1], 1)["ref"].(string)

	// The payload alone is not enough: the signature is what makes a reference unforgeable, so a
	// transcript cannot ask for an arbitrary file.
	payload, _, _ := strings.Cut(ref, ".")
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		t.Fatal(err)
	}
	var parsed imageRef
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	parsed.Path = filepath.Join(filepath.Dir(path), "..", "..", "etc", "passwd")
	forged, err := json.Marshal(parsed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := index.Image(base64.RawURLEncoding.EncodeToString(forged) + "." + strings.SplitN(ref, ".", 2)[1]); err == nil {
		t.Fatal("a reference with a rewritten payload was accepted")
	}

	// Another process (another key) cannot read images from this one.
	other, _ := imageSession(t, imageSessionLines()...)
	if _, err := other.Image(ref); err == nil {
		t.Fatal("a reference from another index was accepted")
	}

	// A tampered signature is refused too, even though the payload is untouched.
	refPayload, refSignature, _ := strings.Cut(ref, ".")
	flipped := refSignature[:len(refSignature)-1] + string(refSignature[len(refSignature)-1]^0x01)
	if _, err := index.Image(refPayload + "." + flipped); err == nil {
		t.Fatal("a reference with a rewritten signature was accepted")
	}
}

func TestImageRejectsGarbageAndUnknownPosition(t *testing.T) {
	index, path := imageSession(t, imageSessionLines()...)
	if _, err := index.Image("not-a-reference"); err == nil {
		t.Fatal("garbage reference was accepted")
	}
	if _, err := index.Image(""); err == nil {
		t.Fatal("empty reference was accepted")
	}
	ref := index.imageRefFor(path, "m1", 0)
	if _, err := index.Image(ref); err == nil {
		t.Fatal("a reference to a text block was served as an image")
	}
	if _, err := index.Image(index.imageRefFor(path, "missing", 1)); err == nil {
		t.Fatal("a reference to a missing entry was served")
	}
}

func TestImageReferenceOutsideTheSessionsRootIsRefused(t *testing.T) {
	index, path := imageSession(t, imageSessionLines()...)
	outside := filepath.Join(t.TempDir(), "outside.jsonl")
	writeSession(t, outside, strings.Join(imageSessionLines(), "\n")+"\n")
	// Signed by this process, but not a session path: the signature alone must not be enough.
	ref := index.imageRefFor(outside, "m1", 1)
	if ref == "" {
		t.Fatal("expected a reference")
	}
	if _, err := index.Image(ref); err == nil {
		t.Fatal("a signed reference to a file outside the sessions root was served")
	}
	if _, err := index.Image(index.imageRefFor(path, "m1", 1)); err != nil {
		t.Fatalf("reference to a session image failed: %v", err)
	}
}