package appservice

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newTestLagLog returns a sink with a clock the test drives, so the rate limit and the day rollover
// are exercised without sleeping.
func newTestLagLog(t *testing.T) (*LagLog, func()) {
	t.Helper()
	dir := t.TempDir()
	clock := time.Date(2026, 10, 3, 1, 2, 3, 0, time.UTC)
	log := NewLagLog(dir)
	log.now = func() time.Time { return clock }
	return log, func() { clock = clock.Add(time.Second) }
}

func postLag(handler http.Handler, body string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, perfLagPrefix, strings.NewReader(body))
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestLagLogAppendsOneLinePerRecord(t *testing.T) {
	log, advance := newTestLagLog(t)
	handler := LagLogMiddleware(log)(http.NotFoundHandler())

	if got := postLag(handler, `{"at":"2026-10-03T01:02:03Z","maxGap":96}`).Code; got != http.StatusAccepted {
		t.Fatalf("first post status = %d, want %d", got, http.StatusAccepted)
	}
	// A second post inside the rate-limit window must not reach the disk at all.
	if got := postLag(handler, `{"at":"2026-10-03T01:02:04Z","maxGap":80}`).Code; got != http.StatusTooManyRequests {
		t.Fatalf("rate limited status = %d, want %d", got, http.StatusTooManyRequests)
	}
	advance()
	if got := postLag(handler, "{\"at\":\"2026-10-03T01:02:05Z\",\"nested\":{\"a\":[1,2]}}").Code; got != http.StatusAccepted {
		t.Fatalf("second post status = %d, want %d", got, http.StatusAccepted)
	}

	raw, err := os.ReadFile(filepath.Join(log.Dir(), "lag-2026-10-03.jsonl"))
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2 {
		t.Fatalf("log has %d lines, want 2: %q", len(lines), string(raw))
	}
	if !strings.Contains(lines[1], `"a":[1,2]`) {
		t.Fatalf("record lost its shape: %s", lines[1])
	}
}

// A client must not be able to smuggle extra lines into the file: that would let one bad record
// stand in for a thousand and make the daily cap meaningless.
func TestLagLogRejectsNonObjects(t *testing.T) {
	log, _ := newTestLagLog(t)
	handler := LagLogMiddleware(log)(http.NotFoundHandler())

	for _, body := range []string{"not json", `["at"]`, `{"nope":1}`, ""} {
		if got := postLag(handler, body).Code; got == http.StatusAccepted {
			t.Fatalf("body %q was accepted", body)
		}
	}
	if _, err := os.Stat(filepath.Join(log.Dir(), "lag-2026-10-03.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("rejected records created a file: %v", err)
	}
}

func TestLagLogHonoursTheEnvSwitch(t *testing.T) {
	t.Setenv(lagEnvVar, "0")
	log := NewLagLog(t.TempDir())
	if log.Dir() != "" {
		t.Fatalf("Dir() = %q, want empty when disabled", log.Dir())
	}
	handler := LagLogMiddleware(log)(http.NotFoundHandler())
	if got := postLag(handler, `{"at":"x"}`).Code; got != http.StatusConflict {
		t.Fatalf("disabled status = %d, want %d", got, http.StatusConflict)
	}
}

func TestLagLogLeavesEveryOtherPathAlone(t *testing.T) {
	log, _ := newTestLagLog(t)
	handler := LagLogMiddleware(log)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/session-transcript", nil))
	if recorder.Code != http.StatusTeapot {
		t.Fatalf("passthrough status = %d, want %d", recorder.Code, http.StatusTeapot)
	}
}

func TestLagLogTailAndChain(t *testing.T) {
	log, advance := newTestLagLog(t)
	handler := ChainAssetMiddleware(
		LagLogMiddleware(log),
		SessionImageMiddleware(&stubImageSource{}),
	)(http.NotFoundHandler())

	for _, gap := range []string{"41", "77"} {
		postLag(handler, `{"at":"2026-10-03T01:02:03Z","maxGap":`+gap+`}`)
		advance()
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, perfLagPrefix+"?limit=1", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("tail status = %d", recorder.Code)
	}
	lines := strings.Split(strings.TrimSpace(recorder.Body.String()), "\n")
	if len(lines) != 1 || !strings.Contains(lines[0], "77") {
		t.Fatalf("tail = %q, want the newest single record", recorder.Body.String())
	}
}

// The cap is the only thing standing between a forgotten instance and a growing pile of files.
func TestLagLogStopsAtTheDailyCap(t *testing.T) {
	log, advance := newTestLagLog(t)
	handler := LagLogMiddleware(log)(http.NotFoundHandler())
	log.written = lagDailyRecords
	log.day = log.pathFor(log.now())
	if got := postLag(handler, `{"at":"x"}`).Code; got != http.StatusInsufficientStorage {
		t.Fatalf("capped status = %d, want %d", got, http.StatusInsufficientStorage)
	}
	advance()
	log.mu.Lock()
	log.lastWrite = time.Time{}
	log.mu.Unlock()
	if got := postLag(handler, `{"at":"x"}`).Code; got != http.StatusInsufficientStorage {
		t.Fatalf("cap must hold across rate-limit resets, got %d", got)
	}
}
