package worktree

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"pi-desk/internal/processutil"
)

const (
	BootstrapNone    = "none"
	BootstrapSymlink = "symlink"
	BootstrapCopy    = "copy"
	BootstrapCommand = "command"

	maxBootstrapCopyBytes = 512 << 20
	maxBootstrapOutput    = 8 << 10
)

// Bootstrap prepares the files git worktree does not copy. The zero value is
// safe: it shares and copies nothing.
type Bootstrap struct {
	Mode    string
	Share   []string
	Copy    []string
	Command string
}

func applyBootstrap(ctx context.Context, repository, worktreePath string, config Bootstrap) error {
	mode := strings.ToLower(strings.TrimSpace(config.Mode))
	if mode == "" {
		mode = BootstrapNone
	}
	switch mode {
	case BootstrapNone:
		return nil
	case BootstrapSymlink:
		return bootstrapSymlinks(repository, worktreePath, config.Share)
	case BootstrapCopy:
		return bootstrapCopy(repository, worktreePath, config.Copy)
	case BootstrapCommand:
		return bootstrapCommand(ctx, worktreePath, config.Command)
	default:
		return fmt.Errorf("unknown bootstrap mode %q", config.Mode)
	}
}

func bootstrapSymlinks(repository, worktreePath string, share []string) error {
	for _, raw := range share {
		relative, err := bootstrapRelative(raw)
		if err != nil {
			return err
		}
		source := filepath.Join(repository, relative)
		info, err := os.Lstat(source)
		if err != nil {
			return fmt.Errorf("share %q: %w", relative, err)
		}
		if !info.IsDir() {
			return fmt.Errorf("share %q is not a directory", relative)
		}
		target := filepath.Join(worktreePath, relative)
		if _, err := os.Lstat(target); err == nil {
			return fmt.Errorf("share target %q already exists in the worktree", relative)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("create share parent %q: %w", relative, err)
		}
		if err := os.Symlink(source, target); err != nil {
			return fmt.Errorf("symlink %q: %w", relative, err)
		}
	}
	return nil
}

func bootstrapCopy(repository, worktreePath string, copyPaths []string) error {
	var copied int64
	for _, raw := range copyPaths {
		relative, err := bootstrapRelative(raw)
		if err != nil {
			return err
		}
		source := filepath.Join(repository, relative)
		target := filepath.Join(worktreePath, relative)
		if err := copyAllowlisted(source, target, &copied); err != nil {
			return fmt.Errorf("copy %q: %w", relative, err)
		}
	}
	return nil
}

func copyAllowlisted(source, target string, copied *int64) error {
	info, err := os.Lstat(source)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("source %s does not exist", source)
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to copy symlink %s", source)
	}
	if info.IsDir() {
		if err := os.MkdirAll(target, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyAllowlisted(filepath.Join(source, entry.Name()), filepath.Join(target, entry.Name()), copied); err != nil {
				return err
			}
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("refusing to copy non-regular file %s", source)
	}
	*copied += info.Size()
	if *copied > maxBootstrapCopyBytes {
		return fmt.Errorf("bootstrap copy exceeds %d bytes", maxBootstrapCopyBytes)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		return err
	}
	return output.Close()
}

func bootstrapCommand(ctx context.Context, worktreePath, command string) error {
	command = strings.TrimSpace(command)
	if command == "" {
		return errors.New("bootstrap command is empty")
	}
	var invocation *exec.Cmd
	if runtime.GOOS == "windows" {
		invocation = exec.CommandContext(ctx, "cmd", "/C", command)
	} else {
		invocation = exec.CommandContext(ctx, "/bin/sh", "-c", command)
	}
	invocation.Dir = worktreePath
	processutil.ConfigureBackground(invocation)
	output, err := invocation.CombinedOutput()
	message := strings.TrimSpace(string(output))
	if len(message) > maxBootstrapOutput {
		message = message[len(message)-maxBootstrapOutput:]
	}
	if err != nil {
		if message != "" {
			return fmt.Errorf("command %q failed: %w: %s", command, err, message)
		}
		return fmt.Errorf("command %q failed: %w", command, err)
	}
	return nil
}

func bootstrapRelative(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("bootstrap path is empty")
	}
	if filepath.IsAbs(value) || filepath.VolumeName(value) != "" {
		return "", fmt.Errorf("bootstrap path %q must be relative", value)
	}
	cleaned := filepath.Clean(value)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("bootstrap path %q escapes the workspace", value)
	}
	first := strings.Split(cleaned, string(os.PathSeparator))[0]
	if first == ".git" || first == ManagedDirectory {
		return "", fmt.Errorf("bootstrap path %q is reserved", value)
	}
	return cleaned, nil
}
