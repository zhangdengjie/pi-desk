package sessionindex

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"
)

// Session images are the one part of a transcript that cannot afford to travel in a snapshot.
//
// A 11.7MB session measured 574-942ms to open, and 94% of those bytes were the base64 of 27
// images: 8.52MB in tool results, 2.21MB in user messages. The reader waits for all of it to be
// parsed, bridged and turned into JS strings before the first line of the transcript paints, and
// then those strings sit in the renderer heap for as long as the task is open.
//
// So a snapshot now ships a *reference* per image instead of its bytes
// (`{"type":"image","mimeType":…,"bytes":…,"ref":"…"}`), and the webview loads the bytes itself
// from the asset server (`/session-image?ref=…`), exactly like any other image in a page. The
// bytes are read back out of the session file on demand, one image at a time, and only when
// something actually displays it.
//
// A reference is `base64url(payload).base64url(hmac-sha256(payload))` under a per-process key, so
// it cannot be forged into a read of any other file: without the key the only reachable paths are
// the ones this process minted, and those are re-validated against the sessions root on the way
// back in (`ValidatePath`).
type imageRef struct {
	Path  string `json:"p"`
	Entry string `json:"e"`
	Block int    `json:"i"`
}

// ImageData is one decoded image, ready to be written to a response body.
type ImageData struct {
	MIMEType string
	Data     []byte
}

func newImageKey() []byte {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		// A process that cannot read randomness serves images inline instead of by reference; it
		// is a worse snapshot, not a broken one, so this is not worth failing startup over.
		return nil
	}
	return key
}

func (index *Index) imageRefFor(path, entryID string, block int) string {
	if len(index.imageKey) == 0 || entryID == "" || block < 0 {
		return ""
	}
	payload, err := json.Marshal(imageRef{Path: path, Entry: entryID, Block: block})
	if err != nil {
		return ""
	}
	mac := hmac.New(sha256.New, index.imageKey)
	mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (index *Index) parseImageRef(value string) (imageRef, bool) {
	if len(index.imageKey) == 0 {
		return imageRef{}, false
	}
	payloadPart, signaturePart, found := strings.Cut(strings.TrimSpace(value), ".")
	if !found {
		return imageRef{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadPart)
	if err != nil {
		return imageRef{}, false
	}
	signature, err := base64.RawURLEncoding.DecodeString(signaturePart)
	if err != nil {
		return imageRef{}, false
	}
	mac := hmac.New(sha256.New, index.imageKey)
	mac.Write(payload)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return imageRef{}, false
	}
	var ref imageRef
	if json.Unmarshal(payload, &ref) != nil {
		return imageRef{}, false
	}
	if ref.Path == "" || ref.Entry == "" || ref.Block < 0 {
		return imageRef{}, false
	}
	return ref, true
}

// Image resolves a reference minted by Snapshot back to one decoded image.
func (index *Index) Image(ref string) (ImageData, error) {
	parsed, ok := index.parseImageRef(ref)
	if !ok {
		return ImageData{}, errors.New("unknown session image reference")
	}
	canonical, err := index.ValidatePath(parsed.Path)
	if err != nil {
		return ImageData{}, err
	}
	return readImageBlock(canonical, parsed.Entry, parsed.Block)
}

// readImageBlock streams the transcript until the entry that owns the image, so serving one image
// does not parse the whole session the way a snapshot does.
func readImageBlock(path, entryID string, block int) (ImageData, error) {
	file, err := os.Open(path)
	if err != nil {
		return ImageData{}, fmt.Errorf("open session transcript: %w", err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), maxLineBytes)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 || !utf8.Valid(line) {
			continue
		}
		var entry rawEntry
		if json.Unmarshal(line, &entry) != nil || entry.Type != "message" || entry.ID != entryID {
			continue
		}
		return imageBlockFromMessage(entry.Message, block)
	}
	if err := scanner.Err(); err != nil {
		return ImageData{}, fmt.Errorf("read session transcript: %w", err)
	}
	return ImageData{}, fmt.Errorf("session entry %q no longer exists", entryID)
}

func imageBlockFromMessage(message json.RawMessage, block int) (ImageData, error) {
	var envelope struct {
		Content json.RawMessage `json:"content"`
	}
	if len(message) == 0 || json.Unmarshal(message, &envelope) != nil || len(envelope.Content) == 0 {
		return ImageData{}, errors.New("session entry has no content")
	}
	var blocks []struct {
		Type     string `json:"type"`
		Data     string `json:"data"`
		MIMEType string `json:"mimeType"`
	}
	if json.Unmarshal(envelope.Content, &blocks) != nil {
		return ImageData{}, errors.New("session entry content is malformed")
	}
	if block >= len(blocks) || blocks[block].Type != "image" {
		return ImageData{}, errors.New("session entry no longer holds an image at that position")
	}
	decoded, err := base64.StdEncoding.DecodeString(blocks[block].Data)
	if err != nil {
		return ImageData{}, errors.New("session image is not valid base64")
	}
	return ImageData{MIMEType: blocks[block].MIMEType, Data: decoded}, nil
}

// stripImageData is what keeps the bytes out of the snapshot: every image block is rewritten to
// carry a reference, a size and its mime type, and the base64 is dropped before the message is
// marshalled. Only blocks that actually have bytes are touched, so a snapshot of a text-only
// session is byte-for-byte what it always was.
func (index *Index) stripImageData(content json.RawMessage, path, entryID string) (json.RawMessage, bool, error) {
	if len(content) == 0 || !bytes.Contains(content, []byte(`"image"`)) {
		return content, false, nil
	}
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(content, &blocks) != nil {
		return content, false, nil
	}
	changed := false
	for position, block := range blocks {
		if string(block["type"]) != `"image"` {
			continue
		}
		rawData, hasData := block["data"]
		if !hasData {
			continue
		}
		ref := index.imageRefFor(path, entryID, position)
		if ref == "" {
			// No signing key (or no entry id): the bytes stay in the snapshot, which is still
			// correct - just as heavy as before.
			continue
		}
		encodedRef, err := json.Marshal(ref)
		if err != nil {
			continue
		}
		block["ref"] = encodedRef
		if size := base64ByteLength(rawData); size > 0 {
			encodedSize, err := json.Marshal(size)
			if err != nil {
				continue
			}
			block["bytes"] = encodedSize
		}
		delete(block, "data")
		changed = true
	}
	if !changed {
		return content, false, nil
	}
	encoded, err := json.Marshal(blocks)
	if err != nil {
		return content, false, err
	}
	return encoded, true, nil
}

// base64ByteLength reports what a base64 literal decodes to without decoding it: the reader only
// wants the size to show next to the thumbnail.
func base64ByteLength(raw json.RawMessage) int {
	encoded := bytes.TrimSpace(raw)
	if len(encoded) < 2 || encoded[0] != '"' || encoded[len(encoded)-1] != '"' {
		return 0
	}
	encoded = encoded[1 : len(encoded)-1]
	if len(encoded) == 0 {
		return 0
	}
	padding := 0
	if encoded[len(encoded)-1] == '=' {
		padding++
		if len(encoded) > 1 && encoded[len(encoded)-2] == '=' {
			padding++
		}
	}
	return len(encoded)/4*3 - padding
}