package sessionindex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLivePiSessionIndex(t *testing.T) {
	if os.Getenv("PI_DESK_LIVE_TEST") != "1" {
		t.Skip("set PI_DESK_LIVE_TEST=1 to scan the local Pi session catalog")
	}
	root, err := DefaultRoot()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	summaries, err := New(root).List(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		t.Fatal(err)
	}
	rootKey := pathKey(absoluteRoot) + string(filepath.Separator)
	for _, summary := range summaries {
		absolutePath, err := filepath.Abs(summary.Path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(pathKey(absolutePath), rootKey) {
			t.Fatalf("session escaped the configured root: %s", summary.Path)
		}
	}
	t.Logf("indexed %d Pi sessions from %s", len(summaries), root)
}

// TestLiveUsageReportPerformance measures the dashboard's two-call pattern on the real catalog:
// the first call parses every transcript, the second one must be served from the per-file cache.
func TestLiveUsageReportPerformance(t *testing.T) {
	if os.Getenv("PI_DESK_LIVE_TEST") != "1" {
		t.Skip("set PI_DESK_LIVE_TEST=1 to scan the local Pi session catalog")
	}
	root, err := DefaultRoot()
	if err != nil {
		t.Fatal(err)
	}
	index := New(root)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	start := time.Now()
	report, err := index.UsageReport(ctx, UsageReportOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cold := time.Since(start)

	start = time.Now()
	cached, err := index.UsageReport(ctx, UsageReportOptions{Days: 7})
	if err != nil {
		t.Fatal(err)
	}
	warm := time.Since(start)

	t.Logf("cold=%s warm=%s files=%d skipped=%d bytes=%d sessions=%d days=%d workspaces=%d tokens=%d",
		cold.Round(time.Millisecond), warm.Round(time.Millisecond), report.Coverage.FilesScanned,
		report.Coverage.FilesSkipped, report.Coverage.BytesRead, report.Totals.Sessions,
		len(report.Days), len(report.Workspaces), report.Totals.Tokens.Total)
	if cached.Totals.Sessions > report.Totals.Sessions {
		t.Fatalf("7-day range reported more sessions than the full range: %d > %d", cached.Totals.Sessions, report.Totals.Sessions)
	}
	if warm > 250*time.Millisecond {
		t.Fatalf("cached report took %s, cache is not working", warm)
	}
}
