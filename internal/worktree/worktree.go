// Package worktree manages git worktrees that isolate one Pi Desk Task from
// the workspace the user is currently editing.
//
// The manager deliberately does not talk to SQLite or the workspace catalog:
// it only owns the filesystem/git side. Task/Run binding, orphan marking and
// workspace registration belong to the application service layer.
package worktree

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/natefinch/atomic"

	"pi-desk/internal/gitexec"
)

const (
	// ManagedDirectory lives inside the repository and is excluded through
	// .git/info/exclude. The repository's .gitignore is never modified.
	ManagedDirectory = ".worktrees"
	// BranchPrefix keeps every Pi Desk worktree branch in one namespace.
	BranchPrefix = "pidesk/task-"
	// excludePattern is anchored at the repository root on purpose: a bare
	// ".worktrees/" would also match nested directories with that name.
	excludePattern = "/.worktrees/"

	maxTaskIDLength = 64
	maxSlugLength   = 48
	maxStatusFiles  = 200
)

var slugPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

var (
	ErrNotRepository    = errors.New("workspace is not a git repository")
	ErrLinkedWorktree   = errors.New("worktrees cannot be created from another worktree")
	ErrInvalidTaskID    = errors.New("task id cannot be used for a worktree")
	ErrInvalidBaseRef   = errors.New("base ref is not a commit")
	ErrWorktreeExists   = errors.New("worktree already exists")
	ErrWorktreeNotFound = errors.New("worktree is not registered")
	ErrUnsafePath       = errors.New("worktree path is not safe")
)

const (
	ReasonDirty    = "worktree has uncommitted changes"
	ReasonUnmerged = "worktree branch has unmerged commits"
	ReasonMissing  = "worktree directory was already missing"
)

// Runner is the narrow git surface this package needs. internal/gitexec.Runner
// implements it; tests may substitute a fake.
type Runner interface {
	Run(ctx context.Context, directory string, args ...string) ([]byte, error)
}

// Manager owns worktree creation and removal. It is safe to use one Manager
// for multiple repositories; no mutable state is kept.
type Manager struct {
	runner Runner
}

func New(runner Runner) *Manager {
	return &Manager{runner: runner}
}

type CreateRequest struct {
	// Repository is any path inside the parent repository. The manager resolves
	// the main worktree root itself.
	Repository string
	// TaskID is the durable Task identity. The path/branch use its short form:
	// task_1234 -> task-1234 / pidesk/task-1234.
	TaskID string
	// BaseRef defaults to HEAD. It may be a branch, tag, or commit.
	BaseRef string
}

type Worktree struct {
	TaskID     string
	Slug       string
	Repository string
	Path       string
	Branch     string
	BaseRef    string
	Head       string
	// Reused is true when the Task already had a registered worktree. Retrying
	// a Task continues in the same directory so previous edits are preserved.
	Reused bool
}

type Info struct {
	Path     string
	Branch   string
	Head     string
	Managed  bool
	Slug     string
	Bare     bool
	Detached bool
	Prunable bool
}

type RemoveRequest struct {
	Repository string
	// TaskID and Path are mutually exclusive. Path is for orphan cleanup when
	// the Task record is already gone.
	TaskID string
	Path   string
}

type RemoveResult struct {
	Path       string
	Branch     string
	Removed    bool
	Orphaned   bool
	BranchKept bool
	Reason     string
}

type FileStatus struct {
	Code string
	Path string
}

type Status struct {
	Path      string
	Branch    string
	Head      string
	Dirty     bool
	Untracked bool
	Unmerged  int
	Truncated bool
	Files     []FileStatus
}

// TaskSlug returns the filesystem/branch-safe short form of a Task id.
func TaskSlug(taskID string) (string, error) {
	_, slug, err := normalizeTaskID(taskID)
	return slug, err
}

// Create adds a worktree for the Task, or returns the existing one. It never
// touches the repository's .gitignore: the managed directory is added to
// .git/info/exclude through the path git itself reports.
func (manager *Manager) Create(ctx context.Context, request CreateRequest) (Worktree, error) {
	root, err := manager.RepositoryRoot(ctx, request.Repository)
	if err != nil {
		return Worktree{}, err
	}
	taskID, slug, err := normalizeTaskID(request.TaskID)
	if err != nil {
		return Worktree{}, err
	}
	baseRef, err := normalizeBaseRef(request.BaseRef)
	if err != nil {
		return Worktree{}, err
	}
	if _, err := manager.run(ctx, root, "rev-parse", "--verify", baseRef+"^{commit}"); err != nil {
		return Worktree{}, fmt.Errorf("%w: %s", ErrInvalidBaseRef, baseRef)
	}

	branch := BranchPrefix + slug
	path := filepath.Join(root, ManagedDirectory, "task-"+slug)

	infos, err := manager.List(ctx, root)
	if err != nil {
		return Worktree{}, err
	}
	for _, info := range infos {
		if !info.Managed || info.Slug != slug {
			continue
		}
		if _, statErr := os.Stat(info.Path); statErr == nil {
			head, _ := manager.run(ctx, info.Path, "rev-parse", "HEAD")
			return Worktree{
				TaskID: taskID, Slug: slug, Repository: root,
				Path: info.Path, Branch: info.Branch, BaseRef: baseRef,
				Head: head, Reused: true,
			}, nil
		}
		// A crashed removal can leave a registration without a directory.
		// Prune it and continue as a fresh creation.
		_, _ = manager.run(ctx, root, "worktree", "prune")
	}

	if _, err := manager.run(ctx, root, "show-ref", "--verify", "--quiet", "refs/heads/"+branch); err == nil {
		return Worktree{}, fmt.Errorf("%w: branch %s already exists without a registered worktree", ErrWorktreeExists, branch)
	}
	if _, err := os.Stat(path); err == nil {
		return Worktree{}, fmt.Errorf("%w: path %s already exists", ErrWorktreeExists, path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Worktree{}, fmt.Errorf("inspect worktree path: %w", err)
	}
	if err := manager.ensureManagedPath(root, path); err != nil {
		return Worktree{}, err
	}
	if err := manager.ensureExclude(ctx, root); err != nil {
		return Worktree{}, fmt.Errorf("exclude managed worktree: %w", err)
	}
	if _, err := manager.run(ctx, root, "worktree", "add", "-b", branch, path, baseRef); err != nil {
		return Worktree{}, fmt.Errorf("create worktree: %w", err)
	}
	head, err := manager.run(ctx, path, "rev-parse", "HEAD")
	if err != nil {
		return Worktree{}, fmt.Errorf("read worktree HEAD: %w", err)
	}
	return Worktree{
		TaskID: taskID, Slug: slug, Repository: root,
		Path: path, Branch: branch, BaseRef: baseRef, Head: head,
	}, nil
}

// List returns every worktree git knows about, including the main worktree.
// Managed marks the ones this package created (branch prefix + managed path).
func (manager *Manager) List(ctx context.Context, repository string) ([]Info, error) {
	root, err := manager.RepositoryRoot(ctx, repository)
	if err != nil {
		return nil, err
	}
	output, err := manager.run(ctx, root, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, fmt.Errorf("list worktrees: %w", err)
	}
	infos := parseWorktreeList(output)
	managedRoot := canonicalPath(filepath.Join(root, ManagedDirectory))
	for index := range infos {
		info := &infos[index]
		branch := strings.TrimPrefix(info.Branch, "refs/heads/")
		info.Branch = branch
		if within(managedRoot, canonicalPath(info.Path)) && strings.HasPrefix(branch, BranchPrefix) {
			info.Managed = true
			info.Slug = strings.TrimPrefix(branch, BranchPrefix)
		}
	}
	sort.Slice(infos, func(left, right int) bool { return infos[left].Path < infos[right].Path })
	return infos, nil
}

// Status reports whether a worktree can be removed safely. Unmerged counts
// commits reachable from the worktree branch but not from the parent HEAD.
func (manager *Manager) Status(ctx context.Context, repository, path string) (Status, error) {
	root, err := manager.RepositoryRoot(ctx, repository)
	if err != nil {
		return Status{}, err
	}
	path = canonicalPath(strings.TrimSpace(path))
	if path == "" {
		return Status{}, errors.New("worktree path is required")
	}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return Status{}, ErrWorktreeNotFound
	}
	if err != nil {
		return Status{}, fmt.Errorf("inspect worktree: %w", err)
	}
	if !info.IsDir() {
		return Status{}, ErrWorktreeNotFound
	}
	branch, err := manager.run(ctx, path, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return Status{}, fmt.Errorf("read worktree branch: %w", err)
	}
	head, err := manager.run(ctx, path, "rev-parse", "HEAD")
	if err != nil {
		return Status{}, fmt.Errorf("read worktree HEAD: %w", err)
	}
	raw, err := manager.runRaw(ctx, path, "status", "--porcelain=v1", "-z", "--untracked-files=normal")
	if err != nil {
		return Status{}, fmt.Errorf("read worktree status: %w", err)
	}
	files, truncated := parseStatus(raw)
	status := Status{
		Path: path, Branch: branch, Head: head,
		Dirty: len(files) > 0, Truncated: truncated, Files: files,
	}
	for _, file := range files {
		if strings.HasPrefix(file.Code, "??") {
			status.Untracked = true
			break
		}
	}
	if branch != "" && branch != "HEAD" {
		count, countErr := manager.run(ctx, root, "rev-list", "--count", "HEAD.."+branch)
		if countErr == nil {
			if parsed, parseErr := strconv.Atoi(strings.TrimSpace(count)); parseErr == nil {
				status.Unmerged = parsed
			}
		}
	}
	return status, nil
}

// Remove deletes a clean worktree and its merged branch. Dirty or unmerged
// worktrees are reported as orphaned instead; the caller decides how to
// surface or clean them.
func (manager *Manager) Remove(ctx context.Context, request RemoveRequest) (RemoveResult, error) {
	root, err := manager.RepositoryRoot(ctx, request.Repository)
	if err != nil {
		return RemoveResult{}, err
	}
	infos, err := manager.List(ctx, root)
	if err != nil {
		return RemoveResult{}, err
	}
	var target Info
	taskID := strings.TrimSpace(request.TaskID)
	requestedPath := strings.TrimSpace(request.Path)
	switch {
	case taskID != "" && requestedPath != "":
		return RemoveResult{}, errors.New("task id and worktree path are mutually exclusive")
	case taskID != "":
		_, slug, slugErr := normalizeTaskID(taskID)
		if slugErr != nil {
			return RemoveResult{}, slugErr
		}
		for _, info := range infos {
			if info.Managed && info.Slug == slug {
				target = info
				break
			}
		}
	case requestedPath != "":
		managedRoot := canonicalPath(filepath.Join(root, ManagedDirectory))
		requestedPath = canonicalPath(requestedPath)
		if !within(managedRoot, requestedPath) {
			return RemoveResult{}, fmt.Errorf("%w: path is outside %s", ErrWorktreeNotFound, managedRoot)
		}
		for _, info := range infos {
			if canonicalPath(info.Path) == requestedPath {
				target = info
				break
			}
		}
	default:
		return RemoveResult{}, errors.New("task id or worktree path is required")
	}
	if target.Path == "" {
		return RemoveResult{}, ErrWorktreeNotFound
	}

	result := RemoveResult{Path: target.Path, Branch: target.Branch}
	if _, statErr := os.Stat(target.Path); errors.Is(statErr, os.ErrNotExist) {
		_, _ = manager.run(ctx, root, "worktree", "prune")
		result.Removed = true
		result.Reason = ReasonMissing
		result.BranchKept = !manager.deleteMergedBranch(ctx, root, target.Branch)
		return result, nil
	} else if statErr != nil {
		return result, fmt.Errorf("inspect worktree: %w", statErr)
	}

	status, err := manager.Status(ctx, root, target.Path)
	if err != nil {
		return result, err
	}
	if status.Dirty || status.Unmerged > 0 {
		result.Orphaned = true
		result.BranchKept = true
		if status.Dirty {
			result.Reason = ReasonDirty
		} else {
			result.Reason = ReasonUnmerged
		}
		return result, nil
	}
	if _, err := manager.run(ctx, root, "worktree", "remove", target.Path); err != nil {
		return result, fmt.Errorf("remove worktree: %w", err)
	}
	result.Removed = true
	result.BranchKept = !manager.deleteMergedBranch(ctx, root, target.Branch)
	return result, nil
}

// Prune removes registrations whose directories disappeared. It returns the
// human-readable lines git reported so the caller can log them.
func (manager *Manager) Prune(ctx context.Context, repository string) ([]string, error) {
	root, err := manager.RepositoryRoot(ctx, repository)
	if err != nil {
		return nil, err
	}
	output, err := manager.run(ctx, root, "worktree", "prune", "--verbose")
	if err != nil {
		return nil, fmt.Errorf("prune worktrees: %w", err)
	}
	if output == "" {
		return nil, nil
	}
	lines := make([]string, 0, 4)
	for _, line := range strings.Split(output, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	return lines, nil
}

// RepositoryRoot resolves the main worktree root and rejects linked worktrees.
func (manager *Manager) RepositoryRoot(ctx context.Context, repository string) (string, error) {
	repository = strings.TrimSpace(repository)
	if repository == "" {
		return "", errors.New("repository path is required")
	}
	inside, err := manager.run(ctx, repository, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return "", ErrNotRepository
	}
	root, err := manager.run(ctx, repository, "rev-parse", "--show-toplevel")
	if err != nil || strings.TrimSpace(root) == "" {
		return "", ErrNotRepository
	}
	root = canonicalPath(root)
	gitDir, gitErr := manager.run(ctx, repository, "rev-parse", "--absolute-git-dir")
	commonDir, commonErr := manager.run(ctx, repository, "rev-parse", "--git-common-dir")
	if gitErr == nil && commonErr == nil {
		commonDir = resolveGitPath(repository, commonDir)
		if canonicalPath(gitDir) != canonicalPath(commonDir) {
			return "", ErrLinkedWorktree
		}
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return "", ErrNotRepository
	}
	return root, nil
}

func (manager *Manager) ensureExclude(ctx context.Context, root string) error {
	output, err := manager.run(ctx, root, "rev-parse", "--git-path", "info/exclude")
	if err != nil {
		return err
	}
	excludePath := strings.TrimSpace(output)
	if excludePath == "" {
		return errors.New("git did not report an exclude path")
	}
	if !filepath.IsAbs(excludePath) {
		excludePath = filepath.Join(root, excludePath)
	}
	excludePath = filepath.Clean(excludePath)
	body, err := os.ReadFile(excludePath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, line := range strings.Split(string(body), "\n") {
		if strings.TrimSpace(line) == excludePattern {
			return nil
		}
	}
	if err := os.MkdirAll(filepath.Dir(excludePath), 0o755); err != nil {
		return err
	}
	next := string(body)
	if next != "" && !strings.HasSuffix(next, "\n") {
		next += "\n"
	}
	next += excludePattern + "\n"
	return atomic.WriteFile(excludePath, strings.NewReader(next))
}

// ensureManagedPath refuses a symlinked .worktrees directory and verifies the
// post-mkdir canonical parent still lives inside the repository. This keeps a
// malicious or accidental symlink from redirecting a worktree outside the repo.
func (manager *Manager) ensureManagedPath(root, path string) error {
	managedRoot := filepath.Join(root, ManagedDirectory)
	if info, err := os.Lstat(managedRoot); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: %s is a symlink", ErrUnsafePath, managedRoot)
	}
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: %s is a symlink", ErrUnsafePath, path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create worktree parent: %w", err)
	}
	if !within(canonicalPath(managedRoot), canonicalPath(filepath.Dir(path))) {
		return fmt.Errorf("%w: %s resolves outside %s", ErrUnsafePath, filepath.Dir(path), managedRoot)
	}
	return nil
}

func (manager *Manager) deleteMergedBranch(ctx context.Context, root, branch string) bool {
	if branch == "" || branch == "HEAD" || !strings.HasPrefix(branch, BranchPrefix) {
		return false
	}
	if _, err := manager.run(ctx, root, "branch", "-d", branch); err != nil {
		return false
	}
	return true
}

func (manager *Manager) run(ctx context.Context, directory string, args ...string) (string, error) {
	output, err := manager.runRaw(ctx, directory, args...)
	return strings.TrimSpace(string(output)), err
}

func (manager *Manager) runRaw(ctx context.Context, directory string, args ...string) ([]byte, error) {
	runner := manager.runner
	if runner == nil {
		runner = gitexec.Runner{}
	}
	return runner.Run(ctx, directory, args...)
}

func normalizeTaskID(value string) (string, string, error) {
	taskID := strings.TrimSpace(value)
	if taskID == "" || len(taskID) > maxTaskIDLength {
		return "", "", ErrInvalidTaskID
	}
	slug := strings.TrimPrefix(taskID, "task_")
	if slug == "" || len(slug) > maxSlugLength || !slugPattern.MatchString(slug) {
		return "", "", ErrInvalidTaskID
	}
	return taskID, slug, nil
}

func normalizeBaseRef(value string) (string, error) {
	ref := strings.TrimSpace(value)
	if ref == "" {
		return "HEAD", nil
	}
	if strings.HasPrefix(ref, "-") || strings.ContainsAny(ref, "\x00\n\r") {
		return "", fmt.Errorf("%w: %s", ErrInvalidBaseRef, ref)
	}
	return ref, nil
}

func parseWorktreeList(output string) []Info {
	var (
		result  []Info
		current Info
	)
	flush := func() {
		if current.Path != "" {
			result = append(result, current)
			current = Info{}
		}
	}
	for _, rawLine := range strings.Split(output, "\n") {
		line := strings.TrimRight(rawLine, "\r")
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, "worktree "):
			current.Path = strings.TrimPrefix(line, "worktree ")
		case strings.HasPrefix(line, "HEAD "):
			current.Head = strings.TrimPrefix(line, "HEAD ")
		case strings.HasPrefix(line, "branch "):
			current.Branch = strings.TrimPrefix(line, "branch ")
		case line == "bare":
			current.Bare = true
		case line == "detached":
			current.Detached = true
		case strings.HasPrefix(line, "prunable"):
			current.Prunable = true
		}
	}
	flush()
	return result
}

func parseStatus(output []byte) ([]FileStatus, bool) {
	tokens := bytes.Split(output, []byte{0})
	files := make([]FileStatus, 0, min(len(tokens), maxStatusFiles))
	truncated := false
	for index := 0; index < len(tokens); index++ {
		token := tokens[index]
		if len(token) < 3 || token[2] != ' ' {
			continue
		}
		code := string(token[:2])
		file := FileStatus{Code: code, Path: string(token[3:])}
		if strings.ContainsAny(code, "RC") && index+1 < len(tokens) {
			index++
		}
		if len(files) >= maxStatusFiles {
			truncated = true
			break
		}
		files = append(files, file)
	}
	return files, truncated
}

func canonicalPath(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	if resolved, resolveErr := filepath.EvalSymlinks(absolute); resolveErr == nil {
		return filepath.Clean(resolved)
	}
	return filepath.Clean(absolute)
}

func resolveGitPath(repository, path string) string {
	path = strings.TrimSpace(path)
	if path == "" || filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Clean(filepath.Join(repository, path))
}

func within(root, target string) bool {
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)))
}
