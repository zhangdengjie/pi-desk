import { onBeforeUnmount } from "vue";

/**
 * Where the reader was left, per document.
 *
 * Deliberately not on the inspector tab. A tab is a transient thing: closing it dropped the
 * position, and the only write path was the panel-state blob, which is one bulk snapshot the app
 * takes when *something else* asks for a save. Reading position is a property of the book, not of
 * the tab that happened to be open, so it lives in its own small map and survives both.
 *
 * Same storage decision as `readerSettings.ts`: `localStorage` is the opaque blob AGENTS.md §1.5
 * asks for, and these values never need to reach the Go side.
 */
export interface ReaderPosition {
  /** PDF: 1-based page. */
  page?: number;
  /** EPUB: CFI of the visible range. */
  cfi?: string;
}

const STORAGE_KEY = "pidesk.reader.positions";
/** Bounded so a long-lived install cannot grow this map without limit. Oldest entries go first. */
const MAX_ENTRIES = 300;
const WRITE_DELAY_MS = 400;

let cache: Record<string, ReaderPosition> | undefined;
let writeTimer: ReturnType<typeof setTimeout> | undefined;

function load(): Record<string, ReaderPosition> {
  if (cache) return cache;
  cache = {};
  if (typeof localStorage === "undefined") return cache;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = (value ?? {}) as Record<string, unknown>;
        const position: ReaderPosition = {};
        if (typeof entry.page === "number" && Number.isFinite(entry.page)) position.page = Math.max(1, Math.trunc(entry.page));
        if (typeof entry.cfi === "string" && entry.cfi) position.cfi = entry.cfi;
        if (position.page !== undefined || position.cfi !== undefined) cache[key] = position;
      }
    }
  } catch {
    /* A corrupt blob reads as "no positions"; the next write replaces it. */
  }
  return cache;
}

function persist(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = undefined;
  }
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(load()));
  } catch {
    /* Private mode or a full quota: the session keeps working from the in-memory copy. */
  }
}

/** Same key shape the reader gets: the workspace plus the file, never the tab id. */
export function readerPositionKey(workspace: string, path: string): string {
  return `${workspace}\u0000${path.replaceAll("\\", "/")}`;
}

export function readPosition(key: string): ReaderPosition | undefined {
  if (!key) return undefined;
  return load()[key];
}

/**
 * Records a position. Writes are coalesced: a page turn emits one call, but scrolling a PDF emits
 * several per second and `localStorage` is synchronous.
 */
export function writePosition(key: string, position: ReaderPosition): void {
  if (!key) return;
  const store = load();
  const previous = store[key];
  if (previous && previous.page === position.page && previous.cfi === position.cfi) return;
  // Re-insert so this key becomes the newest: `MAX_ENTRIES` evicts from the front.
  delete store[key];
  store[key] = position;
  const keys = Object.keys(store);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete store[stale];
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(persist, WRITE_DELAY_MS);
}

/** Flush on unmount so a reader that is closed right after a page turn does not lose it. */
export function usePositionFlush(): void {
  onBeforeUnmount(persist);
}
