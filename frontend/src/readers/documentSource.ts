/**
 * Builds the URL the reader views stream a document from.
 *
 * The bytes deliberately do not travel through the preview RPC: a book is tens of megabytes and the
 * PDF engine asks for it with byte ranges, while the bridge is a single serialised value per
 * message (`internal/appservice/sessionimage.go` measured 4.5MB at ~300ms over the bridge versus
 * 4-6ms over the asset server). `/workspace-file` answers Range with `http.ServeContent`.
 *
 * The shape mirrors `/workspace-image`: `workspaceId` when the thread has one, `root` for threads
 * written before workspace ids existed.
 */
export interface DocumentLocation {
  workspaceId?: string;
  workspacePath: string;
  path: string;
}

export function workspaceFileUrl(location: DocumentLocation): string {
  const query = new URLSearchParams();
  if (location.workspaceId) query.set("workspaceId", location.workspaceId);
  else query.set("root", location.workspacePath);
  query.set("path", location.path.replaceAll("\\", "/"));
  return `/workspace-file?${query.toString()}`;
}

/**
 * Whether the document can be streamed from the route at all.
 *
 * `absolutePath` is only filled in for a local workspace — the same field is empty for SSH, where
 * the bytes exist only on the remote machine. Those still open, through the data URL the preview
 * RPC already returns for small files; the reader treats that as a fallback source rather than a
 * second code path.
 */
export function isStreamableDocument(preview: { absolutePath?: string } | undefined): boolean {
  return Boolean(preview?.absolutePath);
}
