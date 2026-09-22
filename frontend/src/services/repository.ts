import { Dialogs } from "@wailsio/runtime";
import { RepositoryService } from "../../bindings/pi-desk/internal/appservice";
import type {
  RepositoryFileDiff,
  RepositoryFilePreview,
  RepositorySnapshot,
  SessionFileChange,
  SessionFileChanges,
} from "../../bindings/pi-desk/internal/domain";

export type RepositoryWorkspaceReference = string | { workspaceId: string };

function workspaceRequest(reference: RepositoryWorkspaceReference): { workspaceId?: string; workspacePath?: string } {
  return typeof reference === "string" ? { workspacePath: reference } : reference;
}

export const repositoryService = {
  async clipboardFiles(workspace: RepositoryWorkspaceReference): Promise<{ path: string; name: string }[]> {
    return await RepositoryService.ClipboardFiles(workspaceRequest(workspace)) ?? [];
  },
  snapshot(workspace: RepositoryWorkspaceReference): Promise<RepositorySnapshot> {
    return RepositoryService.Snapshot(workspaceRequest(workspace));
  },
  async sessionFileChanges(workspace: RepositoryWorkspaceReference, sessionPath: string): Promise<SessionFileChange[]> {
    const changes = await RepositoryService.SessionFileChanges({ ...workspaceRequest(workspace), sessionPath });
    return changes?.files ?? [];
  },
  rollbackSessionFile(workspace: RepositoryWorkspaceReference, sessionPath: string, path: string): Promise<void> {
    return RepositoryService.RollbackSessionFile({ ...workspaceRequest(workspace), sessionPath, path });
  },
  diff(workspace: RepositoryWorkspaceReference, path: string): Promise<RepositoryFileDiff> {
    return RepositoryService.Diff({ ...workspaceRequest(workspace), path });
  },
  previewFile(workspace: RepositoryWorkspaceReference, path: string): Promise<RepositoryFilePreview> {
    return RepositoryService.PreviewFile({ ...workspaceRequest(workspace), path });
  },
  openFile(workspacePath: string, path: string): Promise<void> {
    return RepositoryService.OpenFile({ workspacePath, path });
  },
  openFileWith(workspacePath: string, path: string): Promise<void> {
    return RepositoryService.OpenFileWith({ workspacePath, path });
  },
  revealFile(workspacePath: string, path: string): Promise<void> {
    return RepositoryService.RevealFile({ workspacePath, path });
  },
  /**
   * Native single-file picker. Deliberately not restricted to the workspace: the composer mention it
   * feeds accepts any path Pi can read, and the repository listing hides ignored files anyway.
   */
  async pickFile(options: { title?: string; directory?: string } = {}): Promise<string | undefined> {
    const picked = await Dialogs.OpenFile({
      Title: options.title ?? "Choose a file",
      CanChooseFiles: true,
      CanChooseDirectories: false,
      CanCreateDirectories: false,
      AllowsMultipleSelection: false,
      AllowsOtherFiletypes: true,
      ResolvesAliases: true,
      ShowHiddenFiles: true,
      Directory: options.directory || undefined,
      Filters: [],
    });
    const path = typeof picked === "string" ? picked : picked[0];
    return path?.trim() ? path.trim() : undefined;
  },
  async saveFileAs(workspacePath: string, path: string, absolutePath: string): Promise<string | undefined> {
    const filename = absolutePath.split(/[\\/]/).pop() || "file";
    const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
    const outputPath = await Dialogs.SaveFile({
      Title: "Save file as",
      Filename: filename,
      Directory: absolutePath.slice(0, Math.max(absolutePath.lastIndexOf("\\"), absolutePath.lastIndexOf("/"))),
      CanCreateDirectories: true,
      AllowsOtherFiletypes: true,
      Filters: extension ? [{ DisplayName: `${extension.slice(1).toUpperCase()} file`, Pattern: `*${extension}` }] : [],
    });
    if (!outputPath) return undefined;
    await RepositoryService.SaveFileAs({ workspacePath, path, outputPath });
    return outputPath;
  },
};

export type { RepositoryFileDiff, RepositoryFilePreview, RepositorySnapshot, SessionFileChange, SessionFileChanges };
