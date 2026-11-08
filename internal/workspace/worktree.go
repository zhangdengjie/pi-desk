package workspace

import (
	"errors"
	"path/filepath"
	"slices"
	"strings"
)

// AddWorktree registers a linked worktree as a child workspace. The child
// inherits the parent's trust; it never becomes an independent trust source.
// The call is idempotent for the same parent/path/task tuple.
func (catalog *Catalog) AddWorktree(parentID, path, branch, taskID string) (Record, error) {
	parentID = strings.TrimSpace(parentID)
	branch = strings.TrimSpace(branch)
	taskID = strings.TrimSpace(taskID)
	if parentID == "" {
		return Record{}, errors.New("parent workspace id is required")
	}
	if branch == "" {
		return Record{}, errors.New("worktree branch is required")
	}
	if taskID == "" {
		return Record{}, errors.New("worktree task id is required")
	}
	canonical, err := CanonicalDirectory(path)
	if err != nil {
		return Record{}, err
	}

	catalog.mu.Lock()
	defer catalog.mu.Unlock()
	if err := catalog.loadLocked(); err != nil {
		return Record{}, err
	}
	var parent *Record
	for index := range catalog.records {
		if catalog.records[index].ID == parentID {
			parent = &catalog.records[index]
			break
		}
	}
	if parent == nil {
		return Record{}, errors.New("parent workspace not found")
	}
	if parent.ParentWorkspaceID != "" {
		return Record{}, errors.New("nested worktrees are not supported")
	}
	if parent.Location.Kind != KindLocal {
		return Record{}, errors.New("worktree requires a local workspace")
	}

	records := slices.Clone(catalog.records)
	for _, record := range records {
		if pathKey(record.Path) != pathKey(canonical) {
			continue
		}
		if record.ParentWorkspaceID == parent.ID && record.WorktreeTaskID == taskID {
			return record, nil
		}
		return Record{}, errors.New("workspace path is already registered")
	}

	now := catalog.now().UTC()
	id, err := newIdentity("workspace")
	if err != nil {
		return Record{}, err
	}
	record := Record{
		ID:   id,
		Name: filepath.Base(canonical),
		Path: canonical,
		Location: Location{
			Kind:  KindLocal,
			Local: LocalLocation{CanonicalPath: canonical},
		},
		Trust:             parent.Trust,
		ParentWorkspaceID: parent.ID,
		WorktreeBranch:    branch,
		WorktreeTaskID:    taskID,
		AddedAt:           now,
		LastOpenedAt:      now,
	}
	records = append(records, record)
	if err := catalog.saveLocked(records, catalog.desktop); err != nil {
		return Record{}, err
	}
	catalog.records = records
	return record, nil
}
