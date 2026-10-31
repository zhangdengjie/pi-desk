package sessionindex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// Cross-session search ("where did I ask about X last week").
//
// The cost model is the opposite of SearchText's: that one may parse a single 12MB transcript
// because the reader asked about it, while this one has to look at every session the user owns
// (417MB / 328 files on the machine this was written for). So the scan is raw-bytes-first - a line
// that does not contain the needle is never unmarshalled - and it is bounded by both bytes and file
// count so a pathological history cannot freeze the app.
const (
	// searchMinQuery is the shortest needle worth scanning for: one CJK character is a real word,
	// one Latin letter is noise that would match every session.
	searchMinQuery = 2
	// searchSnippetRadius is how much context a hit carries on each side, in runes.
	searchSnippetRadius = 60
)

// SearchOptions bounds a cross-session scan. Zero values mean the defaults below.
type SearchOptions struct {
	Limit    int   // hits returned (one per session file)
	MaxBytes int64 // bytes read across all files
	MaxFiles int   // files opened
}

// SearchHit is one session that contains the query, with the first match as context.
type SearchHit struct {
	Path       string    `json:"path"`
	Role       string    `json:"role"`
	Snippet    string    `json:"snippet"`
	Matches    int       `json:"matches"`
	ModifiedAt time.Time `json:"modifiedAt"`
}

// SearchResult carries the hits plus whether the scan stopped early. `Truncated` matters for the
// message shown when nothing was found: "did not look everywhere" is not "there is nothing".
type SearchResult struct {
	Hits      []SearchHit `json:"hits"`
	Truncated bool        `json:"truncated"`
}

const (
	searchDefaultLimit    = 30
	// 512 MiB is ~the whole history on a busy machine (417 MiB / 328 files when this was measured)
	// and costs ~660ms warm, which is why the UI debounces instead of scanning per keystroke.
	searchDefaultMaxBytes = 512 << 20
	searchDefaultMaxFiles = 2000
)

// SearchSessions scans every session transcript for query, newest session first, and returns at
// most options.Limit sessions that contain it. Matching is case-insensitive; the returned snippet
// preserves the original casing.
func (index *Index) SearchSessions(ctx context.Context, query string, options SearchOptions) (SearchResult, error) {
	needle := strings.TrimSpace(query)
	if len([]rune(needle)) < searchMinQuery {
		return SearchResult{Hits: []SearchHit{}}, nil
	}
	if options.Limit <= 0 {
		options.Limit = searchDefaultLimit
	}
	if options.MaxBytes <= 0 {
		options.MaxBytes = searchDefaultMaxBytes
	}
	if options.MaxFiles <= 0 {
		options.MaxFiles = searchDefaultMaxFiles
	}

	root, err := index.canonicalRoot()
	if err != nil {
		if os.IsNotExist(err) {
			return SearchResult{Hits: []SearchHit{}}, nil
		}
		return SearchResult{}, err
	}
	files, err := sessionFiles(root)
	if err != nil {
		return SearchResult{}, err
	}

	// Newest first, so the hit list is useful before the scan finishes and so a budget cutoff drops
	// the oldest sessions rather than the ones the user is most likely asking about.
	type candidate struct {
		path     string
		modified time.Time
	}
	candidates := make([]candidate, 0, len(files))
	for _, path := range files {
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		candidates = append(candidates, candidate{path: path, modified: info.ModTime()})
	}
	sort.Slice(candidates, func(left, right int) bool {
		return candidates[left].modified.After(candidates[right].modified)
	})
	if len(candidates) > options.MaxFiles {
		candidates = candidates[:options.MaxFiles]
	}

	folded := strings.ToLower(needle)
	var (
		mu       sync.Mutex
		hits     []SearchHit
		budget   int64
		stopped  bool
		workers  sync.WaitGroup
		workChan = make(chan candidate)
	)
	stop := func() bool {
		mu.Lock()
		defer mu.Unlock()
		return stopped || len(hits) >= options.Limit
	}
	workerCount := min(maxConcurrentLoads, max(1, len(candidates)))
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			for item := range workChan {
				if stop() {
					continue
				}
				mu.Lock()
				remaining := options.MaxBytes - budget
				mu.Unlock()
				if remaining <= 0 {
					mu.Lock()
					stopped = true
					mu.Unlock()
					continue
				}
				hit, read, ok := scanSessionFile(ctx, item.path, folded, remaining)
				mu.Lock()
				budget += read
				if budget >= options.MaxBytes {
					stopped = true
				}
				if ok {
					hit.ModifiedAt = item.modified
					hits = append(hits, hit)
				}
				mu.Unlock()
			}
		}()
	}
	for _, item := range candidates {
		select {
		case <-ctx.Done():
			stopped = true
		case workChan <- item:
			continue
		}
		break
	}
	close(workChan)
	workers.Wait()
	if err := ctx.Err(); err != nil {
		return SearchResult{}, err
	}

	sort.Slice(hits, func(left, right int) bool {
		return hits[left].ModifiedAt.After(hits[right].ModifiedAt)
	})
	if len(hits) > options.Limit {
		hits = hits[:options.Limit]
	}
	return SearchResult{Hits: hits, Truncated: stopped && len(hits) < options.Limit}, nil
}

// scanSessionFile returns the first match in one transcript, the bytes it read, and whether it found
// anything. `budget` caps how much of the file is read; a file larger than the budget is scanned up
// to that point rather than skipped, because the message the user remembers may be near the top.
func scanSessionFile(ctx context.Context, path, folded string, budget int64) (SearchHit, int64, bool) {
	file, err := os.Open(path)
	if err != nil {
		return SearchHit{}, 0, false
	}
	defer file.Close()

	reader := bufio.NewReaderSize(file, 64<<10)
	var (
		hit     SearchHit
		read    int64
		matches int
		found   bool
	)
	for {
		if err := ctx.Err(); err != nil {
			break
		}
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			read += int64(len(line))
			if !found && bytes.Contains(bytes.ToLower(line), []byte(folded)) {
				if role, text, ok := matchingEntryText(line, folded); ok {
					found = true
					hit = SearchHit{Path: path, Role: role, Snippet: snippetAround(text, folded), Matches: 1}
				}
			} else if found && bytes.Contains(bytes.ToLower(line), []byte(folded)) {
				matches++
			}
		}
		if err != nil || read >= budget {
			break
		}
	}
	if !found {
		return SearchHit{}, read, false
	}
	hit.Matches += matches
	return hit, read, true
}

// matchingEntryText unmarshals one transcript line and reports the role plus the text the needle was
// found in. Only message and compaction entries carry searchable prose; tool arguments and image
// payloads are deliberately left out, same contract as SearchText.
func matchingEntryText(line []byte, folded string) (string, string, bool) {
	var entry rawEntry
	if json.Unmarshal(line, &entry) != nil {
		return "", "", false
	}
	switch entry.Type {
	case "compaction":
		if entry.Summary != "" && containsFold(entry.Summary, folded) {
			return "compaction", entry.Summary, true
		}
		return "", "", false
	case "message":
	default:
		return "", "", false
	}
	if len(entry.Message) == 0 {
		return "", "", false
	}
	var message struct {
		Role    string          `json:"role"`
		Command string          `json:"command"`
		Output  string          `json:"output"`
		Summary string          `json:"summary"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(entry.Message, &message) != nil || !transcriptRoleVisible(message.Role) {
		return "", "", false
	}
	for _, value := range []string{message.Command, message.Output, message.Summary} {
		if value != "" && containsFold(value, folded) {
			return message.Role, value, true
		}
	}
	var plain string
	if json.Unmarshal(message.Content, &plain) == nil {
		if containsFold(plain, folded) {
			return message.Role, plain, true
		}
		return "", "", false
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(message.Content, &blocks) != nil {
		return "", "", false
	}
	for _, block := range blocks {
		if block.Type == "text" && containsFold(block.Text, folded) {
			return message.Role, block.Text, true
		}
	}
	return "", "", false
}

func containsFold(haystack, foldedNeedle string) bool {
	return strings.Contains(strings.ToLower(haystack), foldedNeedle)
}

// snippetAround returns ~searchSnippetRadius runes either side of the first match, on one line, with
// ellipses where it was cut. Byte offsets are avoided on purpose: cutting a CJK transcript at a byte
// boundary produces a replacement character.
func snippetAround(text, folded string) string {
	lower := strings.ToLower(text)
	byteIndex := strings.Index(lower, folded)
	if byteIndex < 0 {
		return collapseWhitespace(text, searchSnippetRadius*2)
	}
	start := len([]rune(lower[:byteIndex]))
	runes := []rune(text)
	from := max(0, start-searchSnippetRadius)
	to := min(len(runes), start+len([]rune(folded))+searchSnippetRadius)
	snippet := collapseWhitespace(string(runes[from:to]), searchSnippetRadius*2+len([]rune(folded)))
	if from > 0 {
		snippet = "…" + snippet
	}
	if to < len(runes) {
		snippet += "…"
	}
	return snippet
}

func collapseWhitespace(text string, limit int) string {
	fields := strings.Fields(text)
	joined := strings.Join(fields, " ")
	runes := []rune(joined)
	if len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return joined
}
