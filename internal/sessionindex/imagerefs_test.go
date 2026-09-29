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

	// A tampered signature is refused too, even though the payload is untouched. Flip a character in
	// the middle: the last base64 character of a 32-byte HMAC carries two unused bits, so flipping
	// its low bit decodes to the same signature and the test only passed by luck.
	refPayload, refSignature, _ := strings.Cut(ref, ".")
	flipped := string(refSignature[0]^0x01) + refSignature[1:]
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
func TestBlankImageDataOnlyTouchesImagePayloads(t *testing.T) {
	unchanged := []string{
		// A text-only line is returned as the very same bytes.
		`{"type":"message","id":"m1","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}`,
		// "type":"image" inside escaped text is not a marker: the raw bytes carry `\"`.
		`{"type":"message","id":"m2","message":{"role":"user","content":[{"type":"text","text":"escaped \"type\":\"image\" and \"data\":\"AAAA\""}]}}`,
		// The value was escaped, so it is not a base64 payload and is left alone.
		`{"type":"message","id":"m3","message":{"role":"user","content":[{"type":"image","data":"a\"b","mimeType":"image/png"}]}}`,
	}
	for _, line := range unchanged {
		if got := string(blankImageData([]byte(line))); got != line {
			t.Fatalf("line was rewritten:\n got %s\nwant %s", got, line)
		}
	}

	rewritten := `{"type":"message","id":"m4","message":{"role":"user","content":[{"type":"text","text":"look"},{"type":"image","data":"aW1hZ2U=","mimeType":"image/png"},{"type":"image","data":"c2hvdA==","mimeType":"image/jpeg"},{"type":"other","data":"keep-me"}]}}`
	blanked := string(blankImageData([]byte(rewritten)))
	if strings.Contains(blanked, "aW1hZ2U=") || strings.Contains(blanked, "c2hvdA==") {
		t.Fatalf("image bytes survived blanking: %s", blanked)
	}
	if !strings.Contains(blanked, `{"type":"other","data":"keep-me"}`) {
		t.Fatalf("a non-image block was changed: %s", blanked)
	}
	var envelope struct {
		Message struct {
			Content []map[string]any `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(blanked), &envelope); err != nil {
		t.Fatalf("blanked line is not valid JSON: %v %s", err, blanked)
	}
	blocks := envelope.Message.Content
	if blocks[1]["bytes"] != float64(5) || blocks[2]["bytes"] != float64(4) {
		t.Fatalf("wrong sizes: %#v", blocks)
	}
}

// The blanking is a pre-parse optimisation, so it must not change what a snapshot says: the same
// session, read both ways, has to produce byte-identical messages.
func TestSnapshotWithBlankedBytesMatchesTheUnblankedPath(t *testing.T) {
	index, path := imageSession(t, imageSessionLines()...)

	blanked, err := index.Snapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := readTranscriptEntries(path)
	if err != nil {
		t.Fatal(err)
	}
	messages, count, model := index.transcriptSnapshot(addCompactionEstimates(activeTranscriptPath(entries)), path)

	if count != blanked.MessageCount || model == nil || blanked.Model == nil || *model != *blanked.Model {
		t.Fatalf("summary differs: %#v vs %#v", count, blanked.MessageCount)
	}
	for position := range messages {
		if string(messages[position]) != string(blanked.Messages[position]) {
			t.Fatalf("message %d differs:\n blanked %s\n   plain %s", position, blanked.Messages[position], messages[position])
		}
	}
}

// A summary only ever needs the message envelope, so blanking image bytes on the way in must not
// change a single field it reports.
func TestSummaryIsUnchangedByBlankedImageBytes(t *testing.T) {
	_, path := imageSession(t, imageSessionLines()...)

	summary, ok := readSummary(path)
	if !ok {
		t.Fatal("summary rejected")
	}
	if summary.FirstMessage != "look" || summary.MessageCount != 3 {
		t.Fatalf("unexpected summary: %#v", summary)
	}
	if summary.ModifiedAt.IsZero() || summary.CreatedAt.IsZero() {
		t.Fatalf("timestamps were dropped: %#v", summary)
	}
}
