/**
 * Which document (PDF / EPUB) tabs keep a live reader.
 *
 * Switching tabs or threads used to unmount the reader, so coming back re-fetched, re-parsed and
 * re-rendered the book behind the loading overlay — and threw away the zoom, the open search and the
 * exact scroll offset. Readers are now hidden instead of destroyed, and the pool spans tabs *and*
 * threads: the key is the tab id (which starts with the thread id), so a reader parked by a thread
 * switch is the same pane the thread comes back to.
 *
 * A hidden reader still holds its parsed document and rendered canvases, so the pool is capped by
 * `documentPool` in ~/.pi-desk/config.json (`internal/userconfig`, read at start-up and on refocus).
 * This constant is only the fallback for a host that cannot answer the config binding (tests, the
 * browser-only preview).
 */
export const DEFAULT_DOCUMENT_POOL = 5;
/** Mirror of `internal/userconfig.maxDocumentPool`; a hand-edited file is clamped there. */
export const MAX_DOCUMENT_POOL = 20;
export const MIN_DOCUMENT_POOL = 1;

/** The reader moved to `activeId` (a document tab). Most recent first, capped. */
export function promoteDocumentId(kept: string[], activeId: string, limit = DEFAULT_DOCUMENT_POOL): string[] {
  return [activeId, ...kept.filter((id) => id !== activeId)].slice(0, Math.max(1, limit));
}

/** Tabs closed or the task changed: forget the ids that no longer exist. */
export function pruneDocumentIds(kept: string[], liveIds: Iterable<string>): string[] {
  const live = new Set(liveIds);
  const next = kept.filter((id) => live.has(id));
  return next.length === kept.length ? kept : next;
}
