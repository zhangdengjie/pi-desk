/**
 * Which terminal tabs keep a live pane.
 *
 * The inspector used to destroy a terminal pane the moment another tab came forward, so switching
 * back rebuilt the whole xterm - `open`, two `reset`, a snapshot RPC and a replay of everything the
 * session printed, 65ms with a blank frame in between (measured with
 * `.pi/bin/hitprobe/devTerminalProbe.ts.keep`, 2026-09-30). Hiding the pane instead costs nothing,
 * but every hidden pane still alive holds a scrollback buffer and keeps parsing its pty's output,
 * so the pool is capped: the terminals the reader actually moves between stay warm, the rest go.
 */
export const TERMINAL_POOL = 2;

/** The reader moved to `activeId` (a terminal tab). Most recent first, capped. */
export function promoteTerminalId(kept: string[], activeId: string): string[] {
  return [activeId, ...kept.filter((id) => id !== activeId)].slice(0, TERMINAL_POOL);
}

/** Tabs closed or the task changed: forget the ids that no longer exist. */
export function pruneTerminalIds(kept: string[], liveIds: Iterable<string>): string[] {
  const live = new Set(liveIds);
  const next = kept.filter((id) => live.has(id));
  return next.length === kept.length ? kept : next;
}
