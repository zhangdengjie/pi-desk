/**
 * Elapsed time as the transcript labels it.
 *
 * Extracted from `ConversationMessage`'s assistant-row duration badge so the compaction row can
 * use the *same* scale steps instead of inventing a second format: a run that took 8.4 s and a
 * compaction that took 8.4 s must read identically, otherwise the two numbers cannot be compared
 * at a glance - which is the whole reason the compaction row shows one.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return `${ms}ms`;
  if (seconds < 60) return `${(ms / 1000).toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}
