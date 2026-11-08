package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Store owns two connection pools against one SQLite file:
//   - write: a single connection, so SQLite never sees concurrent writers.
//   - read: up to four read-only connections, so queries do not queue behind writes.
type Store struct {
	write *sql.DB
	read  *sql.DB
	path  string
}

func Open(path string) (*Store, error) {
	absolute, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return nil, fmt.Errorf("resolve sqlite path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return nil, fmt.Errorf("create sqlite directory: %w", err)
	}
	write, err := sql.Open("sqlite", dsn(absolute, false))
	if err != nil {
		return nil, fmt.Errorf("open sqlite writer: %w", err)
	}
	write.SetMaxOpenConns(1)
	write.SetMaxIdleConns(1)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := write.PingContext(ctx); err != nil {
		_ = write.Close()
		return nil, fmt.Errorf("ping sqlite writer: %w", err)
	}
	if err := migrate(ctx, write); err != nil {
		_ = write.Close()
		return nil, err
	}
	if err := os.Chmod(absolute, 0o600); err != nil {
		_ = write.Close()
		return nil, fmt.Errorf("restrict sqlite permissions: %w", err)
	}

	read, err := sql.Open("sqlite", dsn(absolute, true))
	if err != nil {
		_ = write.Close()
		return nil, fmt.Errorf("open sqlite reader: %w", err)
	}
	read.SetMaxOpenConns(4)
	read.SetMaxIdleConns(4)
	if err := read.PingContext(ctx); err != nil {
		_ = read.Close()
		_ = write.Close()
		return nil, fmt.Errorf("ping sqlite reader: %w", err)
	}

	return &Store{write: write, read: read, path: absolute}, nil
}

func dsn(path string, readOnly bool) string {
	uri := url.URL{Scheme: "file", Path: path}
	params := []string{"_pragma=busy_timeout(5000)"}
	if readOnly {
		params = append(params, "mode=ro", "_pragma=query_only(1)")
	} else {
		params = append(params,
			"_pragma=journal_mode(WAL)",
			"_pragma=synchronous(NORMAL)",
			"_pragma=foreign_keys(1)",
		)
	}
	uri.RawQuery = strings.Join(params, "&")
	return uri.String()
}

func (store *Store) Close() error {
	var errs []error
	if store.read != nil {
		errs = append(errs, store.read.Close())
	}
	if store.write != nil {
		errs = append(errs, store.write.Close())
	}
	return errors.Join(errs...)
}

func (store *Store) Path() string {
	return store.path
}

func unixMilli(value time.Time) int64 {
	return value.UTC().UnixMilli()
}

func timeFromMilli(value int64) time.Time {
	return time.UnixMilli(value).UTC()
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func nullableTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return unixMilli(*value)
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
