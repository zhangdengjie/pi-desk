package worktree

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"pi-desk/internal/gitexec"
)

func TestCreateListReuseAndRemove(t *testing.T) {
	root := initTestRepository(t)
	manager := New(nil)
	ctx := context.Background()

	created, err := manager.Create(ctx, CreateRequest{Repository: root, TaskID: "task_1234_abcd"})
	if err != nil {
		t.Fatal(err)
	}
	wantPath := filepath.Join(created.Repository, ManagedDirectory, "task-1234_abcd")
	if created.Slug != "1234_abcd" || created.Path != wantPath || created.Branch != "pidesk/task-1234_abcd" {
		t.Fatalf("unexpected worktree: %#v", created)
	}
	if created.Reused {
		t.Fatal("first creation must not be marked reused")
	}
	if _, err := os.Stat(filepath.Join(created.Path, "README.md")); err != nil {
		t.Fatalf("worktree did not receive tracked files: %v", err)
	}
	exclude := readTestFile(t, filepath.Join(root, ".git", "info", "exclude"))
	if !strings.Contains(exclude, excludePattern) {
		t.Fatalf("exclude file does not contain %q: %q", excludePattern, exclude)
	}

	if _, err := (gitexec.Runner{}).Run(ctx, root, "check-ignore", "-q", filepath.Join(ManagedDirectory, "task-1234_abcd")+string(os.PathSeparator)); err != nil {
		t.Fatalf("managed directory is not ignored: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".gitignore")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Create must not create .gitignore, err=%v", err)
	}

	infos, err := manager.List(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if len(infos) != 2 {
		t.Fatalf("expected main + linked worktree, got %#v", infos)
	}
	managed := 0
	for _, info := range infos {
		if info.Managed {
			managed++
			if info.Slug != "1234_abcd" || info.Branch != created.Branch {
				t.Fatalf("managed worktree lost its identity: %#v", info)
			}
		}
	}
	if managed != 1 {
		t.Fatalf("expected exactly one managed worktree, got %d", managed)
	}

	again, err := manager.Create(ctx, CreateRequest{Repository: root, TaskID: "task_1234_abcd"})
	if err != nil {
		t.Fatal(err)
	}
	if !again.Reused || again.Path != created.Path || again.Head != created.Head {
		t.Fatalf("same task was not reused: %#v", again)
	}

	removed, err := manager.Remove(ctx, RemoveRequest{Repository: root, TaskID: "task_1234_abcd"})
	if err != nil {
		t.Fatal(err)
	}
	if !removed.Removed || removed.Orphaned || removed.BranchKept {
		t.Fatalf("clean worktree was not removed: %#v", removed)
	}
	if _, err := os.Stat(created.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("worktree directory still exists, err=%v", err)
	}
	if _, err := (gitexec.Runner{}).Run(ctx, root, "show-ref", "--verify", "--quiet", "refs/heads/"+created.Branch); err == nil {
		t.Fatalf("merged branch %s was not deleted", created.Branch)
	}
}

func TestRemoveKeepsDirtyWorktree(t *testing.T) {
	root := initTestRepository(t)
	manager := New(nil)
	ctx := context.Background()
	created, err := manager.Create(ctx, CreateRequest{Repository: root, TaskID: "task_dirty"})
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, created.Path, "notes.txt", "uncommitted\n")

	removed, err := manager.Remove(ctx, RemoveRequest{Repository: root, TaskID: "task_dirty"})
	if err != nil {
		t.Fatal(err)
	}
	if !removed.Orphaned || removed.Removed || !removed.BranchKept || removed.Reason != ReasonDirty {
		t.Fatalf("dirty worktree should be orphaned: %#v", removed)
	}
	if _, err := os.Stat(created.Path); err != nil {
		t.Fatalf("dirty worktree was deleted: %v", err)
	}
	if _, err := (gitexec.Runner{}).Run(ctx, root, "show-ref", "--verify", "--quiet", "refs/heads/"+created.Branch); err != nil {
		t.Fatalf("dirty branch was deleted: %v", err)
	}
}

func TestRemoveKeepsUnmergedBranch(t *testing.T) {
	root := initTestRepository(t)
	manager := New(nil)
	ctx := context.Background()
	created, err := manager.Create(ctx, CreateRequest{Repository: root, TaskID: "task_unmerged"})
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, created.Path, "change.txt", "committed\n")
	runGit(t, created.Path, "add", "change.txt")
	runGit(t, created.Path, "commit", "-qm", "worktree change")

	status, err := manager.Status(ctx, root, created.Path)
	if err != nil {
		t.Fatal(err)
	}
	if status.Dirty || status.Unmerged != 1 {
		t.Fatalf("unexpected status: %#v", status)
	}

	removed, err := manager.Remove(ctx, RemoveRequest{Repository: root, TaskID: "task_unmerged"})
	if err != nil {
		t.Fatal(err)
	}
	if !removed.Orphaned || removed.Removed || !removed.BranchKept || removed.Reason != ReasonUnmerged {
		t.Fatalf("unmerged worktree should be orphaned: %#v", removed)
	}
	if _, err := (gitexec.Runner{}).Run(ctx, root, "show-ref", "--verify", "--quiet", "refs/heads/"+created.Branch); err != nil {
		t.Fatalf("unmerged branch was deleted: %v", err)
	}
}

func TestStatusReportsUntrackedAndClean(t *testing.T) {
	root := initTestRepository(t)
	manager := New(nil)
	ctx := context.Background()
	created, err := manager.Create(ctx, CreateRequest{Repository: root, TaskID: "task_status"})
	if err != nil {
		t.Fatal(err)
	}
	status, err := manager.Status(ctx, root, created.Path)
	if err != nil {
		t.Fatal(err)
	}
	if status.Dirty || status.Untracked || status.Unmerged != 0 || len(status.Files) != 0 {
		t.Fatalf("fresh worktree is not clean: %#v", status)
	}
	writeTestFile(t, created.Path, "untracked.txt", "new\n")
	status, err = manager.Status(ctx, root, created.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Dirty || !status.Untracked || len(status.Files) != 1 || status.Files[0].Code != "??" {
		t.Fatalf("untracked file was not reported: %#v", status)
	}
}

func TestExcludeIsIdempotentAcrossWorktrees(t *testing.T) {
	root := initTestRepository(t)
	manager := New(nil)
	ctx := context.Background()
	if _, err := manager.Create(ctx, CreateRequest{Repository: root, TaskID: "task_one"}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Create(ctx, CreateRequest{Repository: root, TaskID: "task_two"}); err != nil {
		t.Fatal(err)
	}
	exclude := readTestFile(t, filepath.Join(root, ".git", "info", "exclude"))
	if count := strings.Count(exclude, excludePattern); count != 1 {
		t.Fatalf("exclude pattern appears %d times: %q", count, exclude)
	}
}

func TestPruneRemovesMissingRegistration(t *testing.T) {
	root := initTestRepository(t)
	manager := New(nil)
	ctx := context.Background()
	created, err := manager.Create(ctx, CreateRequest{Repository: root, TaskID: "task_prune"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(created.Path); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Prune(ctx, root); err != nil {
		t.Fatal(err)
	}
	infos, err := manager.List(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	for _, info := range infos {
		if info.Managed && info.Slug == "prune" {
			t.Fatalf("pruned worktree is still listed: %#v", info)
		}
	}
}

func TestCreateRejectsInvalidInputs(t *testing.T) {
	root := initTestRepository(t)
	manager := New(nil)
	ctx := context.Background()

	if _, err := manager.Create(ctx, CreateRequest{Repository: root, TaskID: "../escape"}); !errors.Is(err, ErrInvalidTaskID) {
		t.Fatalf("escaping task id error = %v, want %v", err, ErrInvalidTaskID)
	}
	if _, err := manager.Create(ctx, CreateRequest{Repository: root, TaskID: "task_missing", BaseRef: "does-not-exist"}); !errors.Is(err, ErrInvalidBaseRef) {
		t.Fatalf("missing base ref error = %v, want %v", err, ErrInvalidBaseRef)
	}
	if _, err := manager.Create(ctx, CreateRequest{Repository: t.TempDir(), TaskID: "task_not_repo"}); !errors.Is(err, ErrNotRepository) {
		t.Fatalf("non repository error = %v, want %v", err, ErrNotRepository)
	}

	created, err := manager.Create(ctx, CreateRequest{Repository: root, TaskID: "task_linked"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Create(ctx, CreateRequest{Repository: created.Path, TaskID: "task_nested"}); !errors.Is(err, ErrLinkedWorktree) {
		t.Fatalf("linked worktree error = %v, want %v", err, ErrLinkedWorktree)
	}
}

func TestCreateFromSubdirectoryUsesRepositoryRoot(t *testing.T) {
	root := initTestRepository(t)
	manager := New(nil)
	ctx := context.Background()
	subdirectory := filepath.Join(root, "src")
	if err := os.MkdirAll(subdirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	created, err := manager.Create(ctx, CreateRequest{Repository: subdirectory, TaskID: "task_subdir"})
	if err != nil {
		t.Fatal(err)
	}
	if created.Repository != canonicalPath(root) {
		t.Fatalf("repository root = %q, want %q", created.Repository, canonicalPath(root))
	}
	if !within(filepath.Join(created.Repository, ManagedDirectory), created.Path) {
		t.Fatalf("worktree path escaped the managed directory: %#v", created)
	}
}

func TestCreateRejectsSymlinkedManagedDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks requires elevated privileges on Windows")
	}
	root := initTestRepository(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, ManagedDirectory)); err != nil {
		t.Fatal(err)
	}
	manager := New(nil)
	if _, err := manager.Create(context.Background(), CreateRequest{Repository: root, TaskID: "task_symlink"}); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("symlinked managed directory error = %v, want %v", err, ErrUnsafePath)
	}
	entries, err := os.ReadDir(outside)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("symlink target was written to: %#v", entries)
	}
}

func TestRemoveRejectsPathOutsideManagedDirectory(t *testing.T) {
	root := initTestRepository(t)
	manager := New(nil)
	ctx := context.Background()
	if _, err := manager.Remove(ctx, RemoveRequest{Repository: root, Path: root}); !errors.Is(err, ErrWorktreeNotFound) {
		t.Fatalf("outside path error = %v, want %v", err, ErrWorktreeNotFound)
	}
}

func TestCreateRejectsExistingBranchWithoutWorktree(t *testing.T) {
	root := initTestRepository(t)
	manager := New(nil)
	ctx := context.Background()
	runGit(t, root, "branch", "pidesk/task-branch")
	if _, err := manager.Create(ctx, CreateRequest{Repository: root, TaskID: "task_branch"}); !errors.Is(err, ErrWorktreeExists) {
		t.Fatalf("existing branch error = %v, want %v", err, ErrWorktreeExists)
	}
}

func initTestRepository(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	runGit(t, root, "init", "-q")
	runGit(t, root, "config", "user.email", "pi-desk@example.invalid")
	runGit(t, root, "config", "user.name", "Pi Desk Test")
	writeTestFile(t, root, "README.md", "hello\n")
	runGit(t, root, "add", ".")
	runGit(t, root, "commit", "-qm", "initial")
	return root
}

func runGit(t *testing.T, directory string, args ...string) string {
	t.Helper()
	output, err := (gitexec.Runner{}).Run(context.Background(), directory, args...)
	if err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(output))
}

func writeTestFile(t *testing.T, root, name, body string) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readTestFile(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
