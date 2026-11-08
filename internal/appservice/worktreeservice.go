package appservice

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"pi-desk/internal/domain"
	"pi-desk/internal/userconfig"
	"pi-desk/internal/workspace"
	"pi-desk/internal/worktree"
)

const worktreeTimeout = 30 * time.Second

// WorktreeService exposes the git worktree manager to the desktop UI. Task
// execution and Run records stay in TaskService/ScheduledRunner.
type WorktreeService struct {
	manager   *worktree.Manager
	catalog   *workspace.Catalog
	bootstrap func(string) worktree.Bootstrap
}

func NewWorktreeService(manager *worktree.Manager, catalog *workspace.Catalog, resolvers ...func(string) worktree.Bootstrap) *WorktreeService {
	resolver := loadWorktreeBootstrap
	if len(resolvers) > 0 && resolvers[0] != nil {
		resolver = resolvers[0]
	}
	return &WorktreeService{manager: manager, catalog: catalog, bootstrap: resolver}
}

func loadWorktreeBootstrap(workspacePath string) worktree.Bootstrap {
	config, _, err := userconfig.Load()
	if err != nil {
		return worktree.Bootstrap{Mode: worktree.BootstrapNone}
	}
	value := config.WorktreeBootstrapFor(workspacePath)
	return worktree.Bootstrap{Mode: value.Mode, Share: value.Share, Copy: value.Copy, Command: value.Command}
}

func (service *WorktreeService) Enabled() bool {
	return R2WorktreeEnabled()
}

func (service *WorktreeService) Create(request domain.WorktreeCreateRequest) (domain.WorktreeSummary, error) {
	if !service.Enabled() {
		return domain.WorktreeSummary{}, errors.New("worktree support is disabled; set PI_DESK_R2_WORKTREE=1 to enable it")
	}
	if service.manager == nil || service.catalog == nil {
		return domain.WorktreeSummary{}, errors.New("worktree service is unavailable")
	}
	parent, err := service.parentWorkspace(request.WorkspaceID)
	if err != nil {
		return domain.WorktreeSummary{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), worktreeTimeout)
	defer cancel()
	created, err := service.manager.Create(ctx, worktree.CreateRequest{
		Repository: parent.Path,
		TaskID:     request.TaskID,
		BaseRef:    request.BaseRef,
		Bootstrap:  service.bootstrap(parent.Path),
	})
	if err != nil {
		return domain.WorktreeSummary{}, err
	}
	child, err := service.catalog.AddWorktree(parent.ID, created.Path, created.Branch, created.TaskID)
	if err != nil {
		return domain.WorktreeSummary{}, fmt.Errorf("register worktree workspace: %w", err)
	}
	return domain.WorktreeSummary{
		TaskID: created.TaskID, Slug: created.Slug, WorkspaceID: child.ID,
		Path: created.Path, Branch: created.Branch, BaseRef: created.BaseRef,
		Head: created.Head, Managed: true,
	}, nil
}

func (service *WorktreeService) List(request domain.WorktreeListRequest) ([]domain.WorktreeSummary, error) {
	if !service.Enabled() {
		return nil, nil
	}
	if service.manager == nil || service.catalog == nil {
		return nil, errors.New("worktree service is unavailable")
	}
	parent, err := service.parentWorkspace(request.WorkspaceID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), worktreeTimeout)
	defer cancel()
	infos, err := service.manager.List(ctx, parent.Path)
	if err != nil {
		return nil, err
	}
	result := make([]domain.WorktreeSummary, 0, len(infos))
	for _, info := range infos {
		if !info.Managed {
			continue
		}
		summary := domain.WorktreeSummary{
			TaskID: info.Slug, Slug: info.Slug, Path: info.Path,
			Branch: info.Branch, Head: info.Head, Managed: true,
		}
		if child, resolveErr := service.catalog.ResolvePath(info.Path); resolveErr == nil {
			summary.WorkspaceID = child.ID
			summary.TaskID = child.WorktreeTaskID
		}
		if status, statusErr := service.manager.Status(ctx, parent.Path, info.Path); statusErr == nil {
			summary.Dirty = status.Dirty
			summary.Unmerged = status.Unmerged
		}
		result = append(result, summary)
	}
	return result, nil
}

func (service *WorktreeService) Remove(request domain.WorktreeRequest) (domain.WorktreeRemoveResult, error) {
	if !service.Enabled() {
		return domain.WorktreeRemoveResult{}, errors.New("worktree support is disabled; set PI_DESK_R2_WORKTREE=1 to enable it")
	}
	if service.manager == nil || service.catalog == nil {
		return domain.WorktreeRemoveResult{}, errors.New("worktree service is unavailable")
	}
	parent, err := service.parentWorkspace(request.WorkspaceID)
	if err != nil {
		return domain.WorktreeRemoveResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), worktreeTimeout)
	defer cancel()
	childID := service.worktreeWorkspaceID(parent, request)
	removed, err := service.manager.Remove(ctx, worktree.RemoveRequest{
		Repository: parent.Path, TaskID: request.TaskID, Path: request.Path,
	})
	if err != nil {
		return domain.WorktreeRemoveResult{}, err
	}
	result := domain.WorktreeRemoveResult{
		Path: removed.Path, Branch: removed.Branch, Removed: removed.Removed,
		Orphaned: removed.Orphaned, BranchKept: removed.BranchKept, Reason: removed.Reason,
	}
	if removed.Removed && childID != "" {
		_ = service.catalog.Remove(childID)
	}
	return result, nil
}

// removeForThread cleans the worktree bound to a thread, if that thread lives in
// a worktree child workspace. It is used when a Task is archived.
func (service *WorktreeService) removeForThread(threadID string) (domain.WorktreeRemoveResult, bool, error) {
	if !service.Enabled() || service.catalog == nil {
		return domain.WorktreeRemoveResult{}, false, nil
	}
	desktop, err := service.catalog.Desktop()
	if err != nil {
		return domain.WorktreeRemoveResult{}, false, err
	}
	var thread *workspace.ThreadRecord
	for index := range desktop.Threads {
		if desktop.Threads[index].ID == threadID {
			thread = &desktop.Threads[index]
			break
		}
	}
	if thread == nil || strings.TrimSpace(thread.WorkspaceID) == "" {
		return domain.WorktreeRemoveResult{}, false, nil
	}
	child, err := service.catalog.ResolveID(thread.WorkspaceID)
	if err != nil || child.ParentWorkspaceID == "" {
		return domain.WorktreeRemoveResult{}, false, nil
	}
	parent, err := service.catalog.ResolveID(child.ParentWorkspaceID)
	if err != nil {
		return domain.WorktreeRemoveResult{}, false, err
	}
	result, err := service.Remove(domain.WorktreeRequest{WorkspaceID: parent.ID, TaskID: child.WorktreeTaskID})
	return result, true, err
}

func (service *WorktreeService) Prune(request domain.WorktreeListRequest) (domain.WorktreePruneResult, error) {
	if !service.Enabled() {
		return domain.WorktreePruneResult{}, nil
	}
	if service.manager == nil || service.catalog == nil {
		return domain.WorktreePruneResult{}, errors.New("worktree service is unavailable")
	}
	parent, err := service.parentWorkspace(request.WorkspaceID)
	if err != nil {
		return domain.WorktreePruneResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), worktreeTimeout)
	defer cancel()
	removed, err := service.manager.Prune(ctx, parent.Path)
	if err != nil {
		return domain.WorktreePruneResult{}, err
	}
	return domain.WorktreePruneResult{Removed: removed}, nil
}

func (service *WorktreeService) parentWorkspace(id string) (workspace.Record, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return workspace.Record{}, errors.New("workspace id is required")
	}
	record, err := service.catalog.ResolveID(id)
	if err != nil {
		return workspace.Record{}, err
	}
	if record.Location.Kind != workspace.KindLocal {
		return workspace.Record{}, errors.New("worktree isolation is not supported for remote workspaces")
	}
	if record.ParentWorkspaceID != "" {
		return workspace.Record{}, errors.New("worktree isolation requires a parent workspace")
	}
	return record, nil
}

func (service *WorktreeService) worktreeWorkspaceID(parent workspace.Record, request domain.WorktreeRequest) string {
	records, err := service.catalog.List()
	if err != nil {
		return ""
	}
	targetPath := canonicalWorktreePath(request.Path)
	for _, record := range records {
		if record.ParentWorkspaceID != parent.ID {
			continue
		}
		if request.TaskID != "" && record.WorktreeTaskID == request.TaskID {
			return record.ID
		}
		if targetPath != "" && canonicalWorktreePath(record.Path) == targetPath {
			return record.ID
		}
	}
	return ""
}

func canonicalWorktreePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	if resolved, resolveErr := filepath.EvalSymlinks(absolute); resolveErr == nil {
		return filepath.Clean(resolved)
	}
	return filepath.Clean(absolute)
}
