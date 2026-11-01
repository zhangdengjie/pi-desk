package sessionindex

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// usageAssistantLine builds one assistant message carrying provider usage. `stamp` is either an
// RFC3339 string (entry level) or a numeric millisecond value (message level).
func usageAssistantLine(id, parent, provider, model string, messageStamp any, input, output int64) string {
	parentID := "null"
	if parent != "" {
		parentID = fmt.Sprintf("%q", parent)
	}
	stamp := "null"
	switch value := messageStamp.(type) {
	case int64:
		stamp = fmt.Sprintf("%d", value)
	case float64:
		stamp = fmt.Sprintf("%g", value)
	}
	return fmt.Sprintf(
		`{"type":"message","id":%q,"parentId":%s,"message":{"role":"assistant","provider":%q,"model":%q,"timestamp":%s,"content":"ok","usage":{"input":%d,"output":%d,"totalTokens":%d,"cost":{"total":0.01}}}}`,
		id, parentID, provider, model, stamp, input, output, input+output,
	)
}

func usageHeader(cwd string, stamp time.Time) string {
	return fmt.Sprintf(`{"type":"session","version":3,"id":"s","timestamp":%q,"cwd":%q}`, stamp.UTC().Format(time.RFC3339Nano), cwd)
}

func localDay(at time.Time) string {
	return at.Local().Format(usageDayKeyLayout)
}

func TestUsageReportBucketsByLocalDayAndRange(t *testing.T) {
	root := t.TempDir()
	workspaceA := filepath.Join(root, "ws-a")
	workspaceB := filepath.Join(root, "ws-b")
	for _, directory := range []string{workspaceA, workspaceB, filepath.Join(root, "sessions", "a"), filepath.Join(root, "sessions", "b")} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	workspaceA = canonicalTestPath(t, workspaceA)
	workspaceB = canonicalTestPath(t, workspaceB)
	now := time.Now()
	old := now.AddDate(0, 0, -10)

	writeSession(t, filepath.Join(root, "sessions", "a", "one.jsonl"), strings.Join([]string{
		usageHeader(workspaceA, old),
		fmt.Sprintf(`{"type":"message","id":"u1","parentId":null,"message":{"role":"user","timestamp":%d,"content":"hi"}}`, old.UnixMilli()),
		usageAssistantLine("a1", "u1", "openai", "gpt-5", old.UnixMilli(), 100, 20),
		usageAssistantLine("a2", "a1", "openai", "gpt-5", now.UnixMilli(), 300, 40),
	}, "\n")+"\n")
	writeSession(t, filepath.Join(root, "sessions", "b", "two.jsonl"), strings.Join([]string{
		usageHeader(workspaceB, now),
		usageAssistantLine("b1", "", "deepseek", "deepseek-v3", now.UnixMilli(), 50, 10),
	}, "\n")+"\n")

	index := New(filepath.Join(root, "sessions"))
	report, err := index.UsageReport(context.Background(), UsageReportOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if report.Coverage.FilesScanned != 2 || report.Coverage.FilesSkipped != 0 || report.Coverage.BytesRead == 0 {
		t.Fatalf("unexpected coverage: %#v", report.Coverage)
	}
	if len(report.Days) != 2 {
		t.Fatalf("expected two day buckets, got %#v", report.Days)
	}
	if report.Days[0].Date >= report.Days[1].Date {
		t.Fatalf("days are not ascending: %#v", report.Days)
	}
	if report.Totals.Sessions != 2 || report.Totals.Messages != 4 {
		t.Fatalf("unexpected totals: %#v", report.Totals)
	}

	// The "all" range must agree with the pre-existing aggregate: same reader, same numbers.
	usage, err := index.Usage(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if report.Totals.Tokens != usage.Tokens || report.Totals.Cost != usage.Cost ||
		report.Totals.Sessions != usage.Sessions || report.Totals.Messages != usage.Messages {
		t.Fatalf("report totals %#v disagree with Usage %#v", report.Totals, usage)
	}

	todayReport, err := index.UsageReport(context.Background(), UsageReportOptions{Days: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(todayReport.Days) != 1 || todayReport.Days[0].Date != localDay(now) {
		t.Fatalf("today range picked the wrong day: %#v", todayReport.Days)
	}
	if todayReport.Totals.Tokens.Total != 300+40+50+10 {
		t.Fatalf("today range kept out-of-range tokens: %#v", todayReport.Totals.Tokens)
	}
	if todayReport.Totals.Sessions != 2 || todayReport.Totals.Messages != 2 {
		t.Fatalf("unexpected today totals: %#v", todayReport.Totals)
	}

	workspaceReport, err := index.UsageReport(context.Background(), UsageReportOptions{WorkspacePath: workspaceA})
	if err != nil {
		t.Fatal(err)
	}
	if workspaceReport.Totals.Sessions != 1 || workspaceReport.Totals.Tokens.Total != 460 {
		t.Fatalf("workspace filter leaked: %#v", workspaceReport.Totals)
	}
	if len(workspaceReport.Workspaces) != 1 || workspaceReport.Workspaces[0].Path != workspaceA || workspaceReport.Workspaces[0].Name != "ws-a" {
		t.Fatalf("unexpected workspace grouping: %#v", workspaceReport.Workspaces)
	}
}

func TestUsageReportAcceptsSecondMillisecondAndMicrosecondStamps(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "ws")
	for _, directory := range []string{workspace, filepath.Join(root, "sessions", "a")} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	workspace = canonicalTestPath(t, workspace)
	instant := time.Now().Add(-time.Hour)
	writeSession(t, filepath.Join(root, "sessions", "a", "stamps.jsonl"), strings.Join([]string{
		usageHeader(workspace, instant),
		usageAssistantLine("s", "", "openai", "gpt-5", instant.Unix(), 10, 1),
		usageAssistantLine("ms", "s", "openai", "gpt-5", instant.UnixMilli(), 10, 1),
		usageAssistantLine("us", "ms", "openai", "gpt-5", instant.UnixMicro(), 10, 1),
	}, "\n")+"\n")

	report, err := New(filepath.Join(root, "sessions")).UsageReport(context.Background(), UsageReportOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Days) != 1 || report.Days[0].Date != localDay(instant) {
		t.Fatalf("stamp units split one instant across days: %#v", report.Days)
	}
	if report.Days[0].Tokens.Total != 33 {
		t.Fatalf("unexpected tokens for one day: %#v", report.Days[0])
	}
}

func TestUsageReportReusesAndInvalidatesCache(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "ws")
	for _, directory := range []string{workspace, filepath.Join(root, "sessions", "a")} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	workspace = canonicalTestPath(t, workspace)
	path := filepath.Join(root, "sessions", "a", "cache.jsonl")
	now := time.Now()
	writeSession(t, path, strings.Join([]string{
		usageHeader(workspace, now),
		usageAssistantLine("a1", "", "openai", "gpt-5", now.UnixMilli(), 100, 10),
	}, "\n")+"\n")

	index := New(filepath.Join(root, "sessions"))
	first, err := index.UsageReport(context.Background(), UsageReportOptions{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := index.UsageReport(context.Background(), UsageReportOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if first.Totals.Tokens != second.Totals.Tokens || first.Totals.Cost != second.Totals.Cost {
		t.Fatalf("cached report changed numbers: %#v vs %#v", first.Totals, second.Totals)
	}

	writeSession(t, path, strings.Join([]string{
		usageHeader(workspace, now),
		usageAssistantLine("a1", "", "openai", "gpt-5", now.UnixMilli(), 100, 10),
		usageAssistantLine("a2", "a1", "openai", "gpt-5", now.UnixMilli(), 400, 40),
	}, "\n")+"\n")
	third, err := index.UsageReport(context.Background(), UsageReportOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if third.Totals.Tokens.Total != first.Totals.Tokens.Total+440 {
		t.Fatalf("cache did not notice a rewritten transcript: %#v", third.Totals.Tokens)
	}
}

func TestUsageReportCapsSessionRows(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "ws")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	workspace = canonicalTestPath(t, workspace)
	now := time.Now()
	for i, input := range []int64{900, 500, 100} {
		directory := filepath.Join(root, "sessions", fmt.Sprintf("p%d", i))
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
		writeSession(t, filepath.Join(directory, "s.jsonl"), strings.Join([]string{
			usageHeader(workspace, now),
			usageAssistantLine("a", "", "openai", "gpt-5", now.UnixMilli(), input, 1),
		}, "\n")+"\n")
	}
	index := New(filepath.Join(root, "sessions"))
	report, err := index.UsageReport(context.Background(), UsageReportOptions{TopN: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Sessions) != 2 {
		t.Fatalf("TopN not applied: %#v", report.Sessions)
	}
	if report.Sessions[0].Tokens.Total <= report.Sessions[1].Tokens.Total {
		t.Fatalf("sessions are not sorted by tokens: %#v", report.Sessions)
	}
	if report.Sessions[0].Title == "" && report.Sessions[0].Path == "" {
		t.Fatalf("session row lost its identity: %#v", report.Sessions[0])
	}
	all, err := index.UsageReport(context.Background(), UsageReportOptions{TopN: -1})
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Sessions) != 0 || all.Totals.Sessions != 3 {
		t.Fatalf("negative TopN should skip rows but keep totals: %#v", all)
	}
}
