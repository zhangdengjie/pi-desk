package appservice

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// perfLagPrefix is the route the webview posts its own frame records to. It exists because the
// gestures that stutter (a divider drag while an answer streams) are intermittent and only visible
// on the user's machine: a probe that has to be armed by hand after the fact can never catch them.
// The browser side is `frontend/src/services/lagRecorder.ts`; this half only decides what lands on
// disk and how much of it.
const perfLagPrefix = "/perf-lag"

// lagEnvVar opts out. The recorder is on by default precisely so a report like "拖动卡了一下"
// arrives with numbers attached; `PI_DESK_LAG_LOG=0` turns it off and the frontend stops sampling
// after the first rejected post.
const lagEnvVar = "PI_DESK_LAG_LOG"

const (
	// lagMaxBody caps one record: the frontend sends a compact frame window, and anything bigger
	// means a bug, not a longer stall.
	lagMaxBody = 256 << 10
	// lagMinInterval keeps a hard stutter (every frame over 50ms for a minute) from writing once
	// per frame. Records are ~2KB, so this also bounds the byte rate on its own.
	lagMinInterval = 500 * time.Millisecond
	// lagDailyRecords and lagMaxDirBytes are the two stops on total disk use: the day file can
	// not grow past ~4MB and the whole directory is trimmed at 8MB, so a forgotten instance can
	// never fill a volume.
	lagDailyRecords = 2000
	lagMaxDirBytes  = int64(8 << 20)
)

// LagLog appends browser frame records to `<dataDir>/perf/lag-YYYY-MM-DD.jsonl`, one JSON object
// per line. It is deliberately not wired to the settings/state file: a diagnostic that can corrupt
// state.json is worse than the stutter it is measuring.
type LagLog struct {
	dir     string
	enabled bool

	mu        sync.Mutex
	now       func() time.Time
	lastWrite time.Time
	// day is the file name the counter below belongs to, so the per-day cap resets on rollover
	// without a timer of its own.
	day     string
	written int
}

// NewLagLog resolves the directory and the PI_DESK_LAG_LOG switch. An empty dir disables the sink
// rather than writing next to the binary, so a test or a misconfigured launch never sprays files.
func NewLagLog(dir string) *LagLog {
	enabled := true
	switch strings.ToLower(strings.TrimSpace(os.Getenv(lagEnvVar))) {
	case "0", "false", "off", "no":
		enabled = false
	}
	return &LagLog{dir: dir, enabled: enabled, now: time.Now}
}

// Dir reports where records go ("" when the sink is disabled by configuration).
func (log *LagLog) Dir() string {
	if log == nil || !log.enabled {
		return ""
	}
	return log.dir
}

// Record validates one post and appends it. The body must be a single JSON object; it is
// re-compacted so a client can never inject extra lines or a multi-megabyte blob.
func (log *LagLog) Record(body []byte) (int, error) {
	if log == nil || log.dir == "" {
		return http.StatusConflict, fmt.Errorf("lag log disabled")
	}
	if !log.enabled {
		return http.StatusConflict, fmt.Errorf("lag log disabled by %s", lagEnvVar)
	}
	if len(body) == 0 {
		return http.StatusBadRequest, fmt.Errorf("empty record")
	}
	if len(body) > lagMaxBody {
		return http.StatusRequestEntityTooLarge, fmt.Errorf("record too large")
	}
	var probe map[string]any
	if err := json.Unmarshal(body, &probe); err != nil {
		return http.StatusBadRequest, fmt.Errorf("record is not a JSON object: %w", err)
	}
	if _, has := probe["at"]; !has {
		return http.StatusBadRequest, fmt.Errorf("record has no timestamp")
	}
	compact := &bytes.Buffer{}
	if err := json.Compact(compact, body); err != nil {
		return http.StatusBadRequest, fmt.Errorf("compact record: %w", err)
	}

	log.mu.Lock()
	defer log.mu.Unlock()

	// Rate limit before any disk work: a stall storm is exactly when this is called hardest.
	if now := log.now(); !log.lastWrite.IsZero() && now.Sub(log.lastWrite) < lagMinInterval {
		return http.StatusTooManyRequests, fmt.Errorf("lag log rate limited")
	}
	if err := os.MkdirAll(log.dir, 0o755); err != nil {
		return http.StatusInternalServerError, fmt.Errorf("create lag log dir: %w", err)
	}
	path := log.pathFor(log.now())
	if log.written == 0 || log.pathFor(log.now()) != log.day {
		log.resetFor(path)
	}
	if log.written >= lagDailyRecords {
		return http.StatusInsufficientStorage, fmt.Errorf("lag log daily cap reached")
	}
	if size, err := log.dirBytes(); err == nil && size >= lagMaxDirBytes {
		log.trim()
		if size, err = log.dirBytes(); err == nil && size >= lagMaxDirBytes {
			return http.StatusInsufficientStorage, fmt.Errorf("lag log directory is full")
		}
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return http.StatusInternalServerError, fmt.Errorf("open lag log: %w", err)
	}
	defer file.Close()
	if _, err := file.Write(append(compact.Bytes(), '\n')); err != nil {
		return http.StatusInternalServerError, fmt.Errorf("append lag log: %w", err)
	}
	log.written++
	log.lastWrite = log.now()
	return http.StatusAccepted, nil
}

// resetFor starts counting one day's records, including whatever an earlier process of the same
// instance already wrote, so restarting the app cannot double the daily cap.
func (log *LagLog) resetFor(path string) {
	log.day = path
	log.written = 0
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	log.written = len(bytes.Split(bytes.TrimSpace(raw), []byte{'\n'}))
	if bytes.Equal(bytes.TrimSpace(raw), []byte{}) {
		log.written = 0
	}
}

// pathFor names the file for a given instant.
func (log *LagLog) pathFor(at time.Time) string {
	return filepath.Join(log.dir, "lag-"+at.UTC().Format("2006-01-02")+".jsonl")
}

// Tail returns the last `limit` records, newest last, for `GET /perf-lag`.
func (log *LagLog) Tail(limit int) ([]string, error) {
	if log == nil || log.dir == "" {
		return nil, fmt.Errorf("lag log disabled")
	}
	names, err := log.files()
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	out := []string{}
	for i := len(names) - 1; i >= 0 && len(out) < limit; i-- {
		raw, err := os.ReadFile(filepath.Join(log.dir, names[i]))
		if err != nil {
			continue
		}
		lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
		for j := len(lines) - 1; j >= 0 && len(out) < limit; j-- {
			if strings.TrimSpace(lines[j]) != "" {
				out = append(out, lines[j])
			}
		}
	}
	sort.Strings(out) // only reorders the fetched window; callers read `at` anyway
	return out, nil
}

func (log *LagLog) files() ([]string, error) {
	entries, err := os.ReadDir(log.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), "lag-") && strings.HasSuffix(entry.Name(), ".jsonl") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

func (log *LagLog) dirBytes() (int64, error) {
	names, err := log.files()
	if err != nil {
		return 0, err
	}
	var total int64
	for _, name := range names {
		info, err := os.Stat(filepath.Join(log.dir, name))
		if err != nil {
			continue
		}
		total += info.Size()
	}
	return total, nil
}

// trim drops the oldest day files until the directory fits again. Newest data is the only data
// worth keeping from a diagnostic log.
func (log *LagLog) trim() {
	names, err := log.files()
	if err != nil || len(names) < 2 {
		return
	}
	for _, name := range names[:len(names)-1] {
		if size, err := log.dirBytes(); err != nil || size < lagMaxDirBytes {
			return
		}
		_ = os.Remove(filepath.Join(log.dir, name))
	}
}

// LagLogMiddleware serves `POST /perf-lag` (append one record) and `GET /perf-lag?limit=N`
// (read the tail back). Every other path passes through untouched, exactly like the session
// routes: this runs in front of the whole asset chain.
func LagLogMiddleware(log *LagLog) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path != perfLagPrefix {
				next.ServeHTTP(writer, request)
				return
			}
			switch request.Method {
			case http.MethodPost:
				body, err := readCappedBody(request, lagMaxBody)
				if err != nil {
					http.Error(writer, "lag log body is unreadable", http.StatusRequestEntityTooLarge)
					return
				}
				status, err := log.Record(body)
				if err != nil {
					http.Error(writer, err.Error(), status)
					return
				}
				writer.WriteHeader(status)
			case http.MethodGet:
				limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
				lines, err := log.Tail(limit)
				if err != nil {
					http.Error(writer, err.Error(), http.StatusConflict)
					return
				}
				writer.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
				for _, line := range lines {
					_, _ = writer.Write([]byte(line + "\n"))
				}
			default:
				writer.Header().Set("Allow", "GET, POST")
				http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
			}
		})
	}
}

// ChainAssetMiddleware composes asset-server middlewares, keeping each one a pass-through for the
// paths it does not own.
func ChainAssetMiddleware(middlewares ...func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		for i := len(middlewares) - 1; i >= 0; i-- {
			next = middlewares[i](next)
		}
		return next
	}
}

// readCappedBody reads at most max bytes; a body longer than that is a client bug and gets an
// error rather than an allocation.
func readCappedBody(request *http.Request, max int) ([]byte, error) {
	defer request.Body.Close()
	return io.ReadAll(io.LimitReader(request.Body, int64(max)+1))
}
