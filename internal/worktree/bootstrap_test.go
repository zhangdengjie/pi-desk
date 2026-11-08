package worktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBootstrapNoneDoesNotCopyDependencies(t *testing.T) {
	root := initTestRepository(t)
	writeTestFile(t, root, "node_modules/keep.txt", "shared\n")
	writeTestFile(t, root, ".env", "SECRET=1\n")
	manager := New(nil)
	created, err := manager.Create(context.Background(), CreateRequest{Repository: root, TaskID: "task_none"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(created.Path, "node_modules")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("none mode copied node_modules, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(created.Path, ".env")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("none mode copied .env, err=%v", err)
	}
}

func TestBootstrapCopyHonorsAllowlist(t *testing.T) {
	root := initTestRepository(t)
	writeTestFile(t, root, ".env.example", "SAFE=1\n")
	writeTestFile(t, root, ".env", "SECRET=1\n")
	writeTestFile(t, root, "node_modules/keep.txt", "shared\n")
	manager := New(nil)
	created, err := manager.Create(context.Background(), CreateRequest{
		Repository: root, TaskID: "task_copy",
		Bootstrap: Bootstrap{Mode: BootstrapCopy, Copy: []string{".env.example"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(created.Path, ".env.example")); err != nil {
		t.Fatalf("allowlisted file was not copied: %v", err)
	}
	for _, forbidden := range []string{".env", "node_modules"} {
		if _, err := os.Stat(filepath.Join(created.Path, forbidden)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s should not be copied, err=%v", forbidden, err)
		}
	}
}

func TestBootstrapSymlinkSharesDependencyDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs elevated privileges on Windows")
	}
	root := initTestRepository(t)
	writeTestFile(t, root, "node_modules/keep.txt", "shared\n")
	manager := New(nil)
	created, err := manager.Create(context.Background(), CreateRequest{
		Repository: root, TaskID: "task_symlink",
		Bootstrap: Bootstrap{Mode: BootstrapSymlink, Share: []string{"node_modules"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(filepath.Join(created.Path, "node_modules"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("node_modules is not a symlink: %v", info.Mode())
	}
	body, err := os.ReadFile(filepath.Join(created.Path, "node_modules", "keep.txt"))
	if err != nil || string(body) != "shared\n" {
		t.Fatalf("shared dependency unavailable: %q, %v", body, err)
	}
}

func TestBootstrapCommandRunsInsideWorktree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test uses a POSIX shell command")
	}
	root := initTestRepository(t)
	manager := New(nil)
	created, err := manager.Create(context.Background(), CreateRequest{
		Repository: root, TaskID: "task_command",
		Bootstrap: Bootstrap{Mode: BootstrapCommand, Command: "printf ok > bootstrap.txt"},
	})
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(created.Path, "bootstrap.txt"))
	if err != nil || string(body) != "ok" {
		t.Fatalf("bootstrap command did not run in the worktree: %q, %v", body, err)
	}
}

func TestBootstrapCommandFailureIsActionable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test uses a POSIX shell command")
	}
	root := initTestRepository(t)
	manager := New(nil)
	_, err := manager.Create(context.Background(), CreateRequest{
		Repository: root, TaskID: "task_command_fail",
		Bootstrap: Bootstrap{Mode: BootstrapCommand, Command: "echo missing-dependency >&2; exit 7"},
	})
	if err == nil || !strings.Contains(err.Error(), "missing-dependency") {
		t.Fatalf("bootstrap failure = %v, want command output", err)
	}
}

func TestBootstrapRejectsEscapingAndReservedPaths(t *testing.T) {
	root := initTestRepository(t)
	manager := New(nil)
	if _, err := manager.Create(context.Background(), CreateRequest{
		Repository: root, TaskID: "task_escape",
		Bootstrap: Bootstrap{Mode: BootstrapCopy, Copy: []string{"../outside"}},
	}); err == nil {
		t.Fatal("escaping bootstrap path was accepted")
	}
	if _, err := manager.Create(context.Background(), CreateRequest{
		Repository: root, TaskID: "task_git",
		Bootstrap: Bootstrap{Mode: BootstrapCopy, Copy: []string{".git/config"}},
	}); err == nil {
		t.Fatal("reserved .git path was accepted")
	}
	if _, err := manager.Create(context.Background(), CreateRequest{
		Repository: root, TaskID: "task_unknown",
		Bootstrap: Bootstrap{Mode: "unknown"},
	}); err == nil {
		t.Fatal("unknown bootstrap mode was accepted")
	}
}
