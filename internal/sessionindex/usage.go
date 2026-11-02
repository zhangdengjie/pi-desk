package sessionindex

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// UsageReportOptions narrows a usage report. Zero values mean "everything".
type UsageReportOptions struct {
	// WorkspacePath filters to one workspace's sessions (canonicalised internally).
	WorkspacePath string
	// Days keeps only the last N local calendar days, today included. 0 = no limit.
	Days int
	// TopN caps the session rows; 0 uses the default, negative disables the list.
	TopN int
}

type UsageDay struct {
	Date     string
	Tokens   TokenUsage
	Cost     float64
	Messages int
	Sessions int
}

type UsageWorkspace struct {
	Path     string
	Name     string
	Tokens   TokenUsage
	Cost     float64
	Messages int
	Sessions int
}

type UsageSession struct {
	Path      string
	Title     string
	CWD       string
	Model     string
	Tokens    TokenUsage
	Cost      float64
	Messages  int
	UpdatedAt time.Time
}

type UsageCoverage struct {
	FilesScanned int
	FilesSkipped int
	BytesRead    int64
	// Truncated stays false until a byte budget is added; it exists so the UI can say
	// "these numbers are partial" without a second schema change.
	Truncated bool
	CachedAt  time.Time
}

type UsageReport struct {
	Totals     UsageSummary
	Days       []UsageDay
	Workspaces []UsageWorkspace
	Sessions   []UsageSession
	TopModels  []ModelUsage
	Coverage   UsageCoverage
}

const (
	usageReportDefaultTopN = 20
	usageDayKeyLayout      = "2006-01-02"
)

// usageDayTotals is one file's contribution to one local calendar day.
type usageDayTotals struct {
	Tokens            TokenUsage
	Cost              float64
	Messages          int
	Sessions          int
	UserMessages      int
	AssistantMessages int
	ToolResults       int
	Models            map[string]ModelUsage
}

// usageFileDetail is what a single transcript contributes. It is cached per file so a second
// report (or a range switch) does not re-read 400MB of JSONL.
type usageFileDetail struct {
	Path      string
	Usage     UsageSummary
	CWD       string
	Title     string
	Model     string
	UpdatedAt time.Time
	Bytes     int64
	Days      map[string]usageDayTotals
}

type usageCacheEntry struct {
	Size    int64
	ModTime time.Time
	Detail  usageFileDetail
}

// UsageReport aggregates the same persisted provider usage as Usage, bucketed by local calendar
// day so the dashboard can answer "today / last 7 days / last 30 days" without rescanning.
//
// The numbers are intentionally derived from the same per-file reader as Usage, so the "all" range
// and Usage("") cannot disagree.
func (index *Index) UsageReport(ctx context.Context, options UsageReportOptions) (UsageReport, error) {
	empty := UsageReport{
		Totals:     UsageSummary{Models: []ModelUsage{}},
		Days:       []UsageDay{},
		Workspaces: []UsageWorkspace{},
		Sessions:   []UsageSession{},
		TopModels:  []ModelUsage{},
		Coverage:   UsageCoverage{CachedAt: time.Now()},
	}
	root, err := index.canonicalRoot()
	if errors.Is(err, os.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return UsageReport{}, err
	}
	workspaceKey := ""
	if strings.TrimSpace(options.WorkspacePath) != "" {
		canonical, err := canonicalDirectory(options.WorkspacePath)
		if err != nil {
			return UsageReport{}, err
		}
		workspaceKey = pathKey(canonical)
	}
	files, err := sessionFiles(root)
	if err != nil {
		return UsageReport{}, err
	}
	sinceKey := ""
	if options.Days > 0 {
		now := time.Now()
		start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
		start = start.AddDate(0, 0, -(options.Days - 1))
		sinceKey = start.Format(usageDayKeyLayout)
	}

	type detailResult struct {
		detail usageFileDetail
		ok     bool
	}
	jobs := make(chan string)
	results := make(chan detailResult)
	workerCount := min(maxConcurrentLoads, len(files))
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			for path := range jobs {
				detail, ok := index.usageDetail(path)
				if !ok || (workspaceKey != "" && pathKey(detail.CWD) != workspaceKey) {
					continue
				}
				select {
				case results <- detailResult{detail: detail, ok: true}:
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, path := range files {
			select {
			case jobs <- path:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		workers.Wait()
		close(results)
	}()

	report := empty
	days := make(map[string]*usageDayTotals)
	workspaces := make(map[string]*UsageWorkspace)
	models := make(map[string]ModelUsage)
	sessions := make([]UsageSession, 0, len(files))

	for result := range results {
		detail := result.detail
		report.Coverage.FilesScanned++
		report.Coverage.BytesRead += detail.Bytes

		var fileTokens TokenUsage
		var fileCost float64
		var fileMessages int
		var fileUser, fileAssistant, fileTools int
		touched := false
		for date, totals := range detail.Days {
			if sinceKey != "" && date < sinceKey {
				continue
			}
			touched = true
			bucket := days[date]
			if bucket == nil {
				bucket = &usageDayTotals{Models: make(map[string]ModelUsage)}
				days[date] = bucket
			}
			mergeTokens(&bucket.Tokens, totals.Tokens)
			bucket.Cost += totals.Cost
			bucket.Messages += totals.Messages
			bucket.UserMessages += totals.UserMessages
			bucket.AssistantMessages += totals.AssistantMessages
			bucket.ToolResults += totals.ToolResults
			bucket.Sessions += totals.Sessions
			for key, model := range totals.Models {
				merged := bucket.Models[key]
				merged.Provider, merged.Model = model.Provider, model.Model
				merged.AssistantMessages += model.AssistantMessages
				mergeTokens(&merged.Tokens, model.Tokens)
				merged.Cost += model.Cost
				bucket.Models[key] = merged
			}
			mergeTokens(&fileTokens, totals.Tokens)
			fileCost += totals.Cost
			fileMessages += totals.Messages
			fileUser += totals.UserMessages
			fileAssistant += totals.AssistantMessages
			fileTools += totals.ToolResults
			for key, model := range totals.Models {
				merged := models[key]
				merged.Provider, merged.Model = model.Provider, model.Model
				merged.AssistantMessages += model.AssistantMessages
				mergeTokens(&merged.Tokens, model.Tokens)
				merged.Cost += model.Cost
				models[key] = merged
			}
		}
		if !touched {
			continue
		}

		report.Totals.Sessions++
		report.Totals.Messages += fileMessages
		report.Totals.UserMessages += fileUser
		report.Totals.AssistantMessages += fileAssistant
		report.Totals.ToolResults += fileTools
		mergeTokens(&report.Totals.Tokens, fileTokens)
		report.Totals.Cost += fileCost

		key := pathKey(detail.CWD)
		workspace := workspaces[key]
		if workspace == nil {
			workspace = &UsageWorkspace{Path: detail.CWD, Name: workspaceDisplayName(detail.CWD)}
			workspaces[key] = workspace
		}
		workspace.Sessions++
		workspace.Messages += fileMessages
		mergeTokens(&workspace.Tokens, fileTokens)
		workspace.Cost += fileCost

		if options.TopN >= 0 {
			sessions = append(sessions, UsageSession{
				Path:      detail.Path,
				Title:     detail.Title,
				CWD:       detail.CWD,
				Model:     detail.Model,
				Tokens:    fileTokens,
				Cost:      fileCost,
				Messages:  fileMessages,
				UpdatedAt: detail.UpdatedAt,
			})
		}
	}
	if err := ctx.Err(); err != nil {
		return UsageReport{}, err
	}

	report.Coverage.FilesSkipped = len(files) - report.Coverage.FilesScanned
	report.Coverage.CachedAt = time.Now()

	for date, totals := range days {
		report.Days = append(report.Days, UsageDay{
			Date: date, Tokens: totals.Tokens, Cost: totals.Cost,
			Messages: totals.Messages, Sessions: totals.Sessions,
		})
	}
	slices.SortFunc(report.Days, func(a, b UsageDay) int { return strings.Compare(a.Date, b.Date) })

	for _, workspace := range workspaces {
		report.Workspaces = append(report.Workspaces, *workspace)
	}
	slices.SortFunc(report.Workspaces, func(a, b UsageWorkspace) int {
		if a.Tokens.Total != b.Tokens.Total {
			return compareInt64Desc(a.Tokens.Total, b.Tokens.Total)
		}
		return strings.Compare(a.Path, b.Path)
	})

	report.Totals.Models = sortModelUsage(models)
	report.TopModels = report.Totals.Models

	slices.SortFunc(sessions, func(a, b UsageSession) int {
		if a.Tokens.Total != b.Tokens.Total {
			return compareInt64Desc(a.Tokens.Total, b.Tokens.Total)
		}
		if a.UpdatedAt.After(b.UpdatedAt) {
			return -1
		}
		return 1
	})
	if options.TopN == 0 {
		options.TopN = usageReportDefaultTopN
	}
	if options.TopN > 0 && len(sessions) > options.TopN {
		sessions = sessions[:options.TopN]
	}
	if sessions == nil {
		sessions = []UsageSession{}
	}
	report.Sessions = sessions
	return report, nil
}

func compareInt64Desc(a, b int64) int {
	switch {
	case a > b:
		return -1
	case a < b:
		return 1
	default:
		return 0
	}
}

func sortModelUsage(models map[string]ModelUsage) []ModelUsage {
	sorted := make([]ModelUsage, 0, len(models))
	for _, model := range models {
		sorted = append(sorted, model)
	}
	slices.SortFunc(sorted, func(a, b ModelUsage) int {
		if a.Tokens.Total != b.Tokens.Total {
			return compareInt64Desc(a.Tokens.Total, b.Tokens.Total)
		}
		if order := strings.Compare(a.Provider, b.Provider); order != 0 {
			return order
		}
		return strings.Compare(a.Model, b.Model)
	})
	return sorted
}

func workspaceDisplayName(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return ""
	}
	cleaned := filepath.Clean(trimmed)
	name := filepath.Base(cleaned)
	if name == "." || name == string(filepath.Separator) {
		return cleaned
	}
	return name
}

// detailPath is gone: usageFileDetail carries its own path.

// usageDetail reads (or reuses) one transcript's contribution. The cache key is the file's
// size+mtime, the same invalidation rule the session summary cache uses.
func (index *Index) usageDetail(path string) (usageFileDetail, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return usageFileDetail{}, false
	}
	index.usageMu.Lock()
	entry, cached := index.usageCache[path]
	index.usageMu.Unlock()
	if cached && entry.Size == info.Size() && entry.ModTime.Equal(info.ModTime()) {
		return entry.Detail, true
	}
	detail, ok := readUsageDetail(path, info.ModTime())
	if !ok {
		return usageFileDetail{}, false
	}
	detail.Bytes = info.Size()
	index.usageMu.Lock()
	if index.usageCache == nil {
		index.usageCache = make(map[string]usageCacheEntry)
	}
	index.usageCache[path] = usageCacheEntry{Size: info.Size(), ModTime: info.ModTime(), Detail: detail}
	index.usageMu.Unlock()
	return detail, true
}

// readUsageDetail is the single transcript walker behind both Usage and UsageReport: totals keep
// the historical semantics, Days adds the per-local-day buckets.
func readUsageDetail(path string, fallback time.Time) (usageFileDetail, bool) {
	entries, err := readTranscriptEntries(path)
	if err != nil {
		return usageFileDetail{}, false
	}
	header, ok := readHeader(path)
	if !ok {
		return usageFileDetail{}, false
	}
	detail := usageFileDetail{
		Path:      path,
		Usage:     UsageSummary{Sessions: 1, Models: []ModelUsage{}},
		CWD:       header.CWD,
		UpdatedAt: header.ModifiedAt,
		Days:      make(map[string]usageDayTotals),
	}
	// The transcript header carries no title, so the readable name comes from the same two sources the
	// sidebar uses: Pi's `session_info` name, else the first user message. Without this the usage table
	// showed the file name (a timestamp + UUID), which says nothing about the session.
	var sessionName, firstUserMessage string
	models := make(map[string]ModelUsage)
	latest := detail.UpdatedAt
	for _, entry := range entries {
		var message rawMessage
		countsMessage := false
		switch entry.Type {
		case "message":
			if len(entry.Message) == 0 || json.Unmarshal(entry.Message, &message) != nil {
				continue
			}
			countsMessage = true
			if firstUserMessage == "" && message.Role == "user" {
				firstUserMessage = sessionTitleText(extractText(message.Content))
			}
		case "session_info":
			sessionName = strings.TrimSpace(entry.Name)
			continue
		case "usage", "compaction", "branch_summary":
			message = rawMessage{Provider: entry.Provider, Model: entry.Model, Usage: entry.Usage}
		default:
			continue
		}

		at := usageEntryTime(entry, message)
		// A transcript entry with no usable stamp still consumed tokens; attribute it to the
		// session's own activity time rather than dropping it from every day bucket.
		if at.IsZero() {
			at = header.ModifiedAt
		}
		if at.IsZero() {
			at = header.CreatedAt
		}
		if at.IsZero() {
			at = fallback
		}
		date := ""
		if !at.IsZero() {
			date = at.Local().Format(usageDayKeyLayout)
			if at.After(latest) {
				latest = at
			}
		}
		bucket := detail.Days[date]
		bucket.Sessions = 1

		if countsMessage {
			detail.Usage.Messages++
			bucket.Messages++
			switch message.Role {
			case "user":
				detail.Usage.UserMessages++
				bucket.UserMessages++
			case "assistant":
				detail.Usage.AssistantMessages++
				bucket.AssistantMessages++
			case "toolResult":
				detail.Usage.ToolResults++
				bucket.ToolResults++
			}
		}
		if message.Usage == nil {
			if countsMessage {
				detail.Days[date] = bucket
			}
			continue
		}

		tokens := tokensFromRaw(*message.Usage)
		mergeTokens(&detail.Usage.Tokens, tokens)
		detail.Usage.Cost += message.Usage.Cost.Total
		mergeTokens(&bucket.Tokens, tokens)
		bucket.Cost += message.Usage.Cost.Total

		provider, modelID := strings.TrimSpace(message.Provider), strings.TrimSpace(message.Model)
		if provider != "" || modelID != "" {
			key := provider + "\x00" + modelID
			merged := models[key]
			merged.Provider, merged.Model = provider, modelID
			if message.Role == "assistant" {
				merged.AssistantMessages++
			}
			mergeTokens(&merged.Tokens, tokens)
			merged.Cost += message.Usage.Cost.Total
			models[key] = merged

			if bucket.Models == nil {
				bucket.Models = make(map[string]ModelUsage)
			}
			dayModel := bucket.Models[key]
			dayModel.Provider, dayModel.Model = provider, modelID
			if message.Role == "assistant" {
				dayModel.AssistantMessages++
			}
			mergeTokens(&dayModel.Tokens, tokens)
			dayModel.Cost += message.Usage.Cost.Total
			bucket.Models[key] = dayModel

			if message.Role == "assistant" {
				if modelID != "" {
					detail.Model = modelID
				} else {
					detail.Model = provider
				}
			}
		}
		detail.Days[date] = bucket
	}
	detail.Usage.Models = sortModelUsage(models)
	// Same title rule as the sidebar summary, minus the "Empty session" placeholder: an empty title
	// lets the UI fall back to the file name, which is more useful than repeating a placeholder.
	detail.Title = compactText(sessionName, maxTitleRunes)
	if corruptedAutomaticName(detail.Title, firstUserMessage) {
		detail.Title = ""
	}
	if detail.Title == "" {
		detail.Title = compactText(firstUserMessage, maxTitleRunes)
	}
	// readHeader's ModifiedAt is empty for transcripts whose entries carry only numeric stamps,
	// so the walk's own high-water mark wins when it is later.
	detail.UpdatedAt = latest
	return detail, true
}

// usageEntryTime prefers the message timestamp (a JSON number whose unit varies) and falls back to
// the entry's RFC3339 stamp. Unlike messageTime it does not assume milliseconds: transcripts in the
// wild carry seconds, milliseconds and microseconds, and guessing wrong moves a session a day.
func usageEntryTime(entry rawEntry, message rawMessage) time.Time {
	if message.Timestamp != "" {
		if value, err := strconv.ParseFloat(string(message.Timestamp), 64); err == nil && value > 0 {
			switch {
			case value < 1e11:
				return time.Unix(int64(value), 0).UTC()
			case value < 1e14:
				milliseconds := int64(value)
				return time.Unix(milliseconds/1000, (milliseconds%1000)*int64(time.Millisecond)).UTC()
			default:
				microseconds := int64(value)
				return time.Unix(microseconds/1_000_000, (microseconds%1_000_000)*int64(time.Microsecond)).UTC()
			}
		}
	}
	parsed, _ := time.Parse(time.RFC3339Nano, entry.Timestamp)
	return parsed
}
