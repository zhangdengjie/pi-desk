/**
 * Which document (PDF / EPUB) tabs keep a live reader.
 *
 * Switching tabs used to unmount the reader, so coming back re-fetched, re-parsed and re-rendered
 * the book behind the loading overlay — and threw away the zoom, the open search and the exact
 * scroll offset. Readers are now hidden instead of destroyed, and the tree of tabs in an inspector
 * is small enough that the last couple can stay warm. A hidden reader still holds its parsed
 * document and its canvases, so the pool is capped like the terminal one: the two documents the
 * reader moves between stay, older ones are released.
 */
export const DOCUMENT_POOL = 2;

/** The reader moved to `activeId` (a document tab). Most recent first, capped. */
export function promoteDocumentId(kept: string[], activeId: string): string[] {
  return [activeId, ...kept.filter((id) => id !== activeId)].slice(0, DOCUMENT_POOL);
}

/** Tabs closed or the task changed: forget the ids that no longer exist. */
export function pruneDocumentIds(kept: string[], liveIds: Iterable<string>): string[] {
  const live = new Set(liveIds);
  const next = kept.filter((id) => live.has(id));
  return next.length === kept.length ? kept : next;
}
