/**
 * Expansion memory for the `<details>` panels inside a transcript row
 * (reasoning blocks today, tool panels if they ever need the same treatment).
 *
 * A merged assistant run is keyed by the id of its *final* message, so every
 * new Pi message in the same turn remounts the row (ConversationPane.vue keys
 * `v-for` by `message.id`). Native `<details>` keeps its state in the DOM
 * element, which the remount throws away — the reader sees an open reasoning
 * block snap shut halfway through a run. These panels therefore read and write
 * this registry instead of trusting the DOM.
 *
 * The registry is intentionally module-scoped: ids are per message
 * (`<messageId>-thinking`), stable across turns, and global state is what
 * survives a remount. Size is capped so a long-lived window cannot keep every
 * session's ids forever; entries fall out oldest first.
 */
const MAX_REMEMBERED_PANELS = 500;
const openPanels = new Map<string, boolean>();

function remember(id: string, open: boolean) {
  if (openPanels.size >= MAX_REMEMBERED_PANELS && !openPanels.has(id)) {
    const oldest = openPanels.keys().next().value;
    if (oldest !== undefined) openPanels.delete(oldest);
  }
  openPanels.set(id, open);
}

/** The reader's own choice, or false when they never touched this panel. */
export function isPanelPinnedOpen(id: string): boolean {
  return openPanels.get(id) === true;
}

export function pinPanelOpen(id: string, open: boolean): void {
  remember(id, open);
}

/** Test helper: drop remembered state so cases cannot leak into each other. */
export function forgetPanelOpenStates(): void {
  openPanels.clear();
}
