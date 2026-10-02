/**
 * Two primitives that keep the draft field's *native* undo stack usable.
 *
 * Both come from `.pi/bin/hitprobe/undo-battery.html` (engine rules) and
 * `.pi/bin/hitprobe/undo-real-draft.html` (the shipped component, driven through the same engine
 * primitives), each run in the engine every macOS build ships on (`undoprobe`, i.e. real WKWebView)
 * and in headless Chrome (Blink, i.e. the Windows build). The two engines agreed on all 21 variants
 * and all 6 timed-typing runs. The table is the result:
 *
 * | what happens to `Cmd+Z` after…                                                | WebKit                                        | Blink |
 * |-------------------------------------------------------------------------------|-----------------------------------------------|-------|
 * | typing 6 chars, any gap between them (0 / 300 / 900 / 2000 ms)                 | one undo erases **the whole run**             | same  |
 * | the same typing, with `setSelectionRange(caret, caret)` re-asserted per input  | one undo per **character**                    | same  |
 * | a re-assert only where a word has just ended                                    | one undo per **word**                         | same  |
 * | `element.value = …` (any write, even a full-document one)                      | stack **cleared**: older text unreachable, undo looks stuck | same  |
 * | `element.setRangeText(…)`                                                      | stack cleared                                 | same  |
 * | `document.execCommand('insertText')` / `'delete'` over a selected range         | the edit is one undo step and the stack survives | same  |
 * | the style write + `scrollHeight` read of the auto-resize                         | no effect on the stack                        | same  |
 *
 * So `DraftInput.vue` must (1) never hand-write `value` for a change that could have been patched,
 * and (2) close the engine's typing group on every keystroke, or a single `Cmd+Z` deletes everything
 * the person wrote. `minimalPatch` is (1), `shouldCloseUndoGroup` is (2).
 */

export interface TextPatch {
  /** Offset in the current string where the replacement starts. */
  from: number;
  /** Offset in the current string where it ends (the selection to hand the editor). */
  to: number;
  /** The text that takes its place; "" means "just delete that range". */
  text: string;
}

/**
 * The smallest single replacement that turns `current` into `next`, by trimming the common prefix
 * and suffix. Patching only the difference is what keeps an external draft change (a `@` mention
 * picked from the file panel, a `/command` completion, a queue edit moved back into the composer)
 * inside the undo stack instead of flushing it, and it lets the engine put the caret where the edit
 * actually happened rather than at the end of a re-typed document.
 */
export function minimalPatch(current: string, next: string): TextPatch | undefined {
  if (current === next) return undefined;
  const limit = Math.min(current.length, next.length);
  let from = 0;
  while (from < limit && current[from] === next[from]) from++;
  let endCurrent = current.length;
  let endNext = next.length;
  // Never overlap the prefix: `from` is the floor for both cursors, or "ab" -> "aab" would trim the
  // shared "ab" off the suffix side too and report {from:2,to:2,text:"a"}, which applies as "aba".
  while (endCurrent > from && endNext > from && current[endCurrent - 1] === next[endNext - 1]) {
    endCurrent--;
    endNext--;
  }
  return { from, to: endCurrent, text: next.slice(from, endNext) };
}

export interface UndoGroupQuestion {
  /** `InputEvent.inputType`; `""` when the engine does not report one. */
  inputType: string;
  /** Characters the edit that just landed added or removed. */
  charsSinceGroup: number;
  /** An open IME session owns the field: touching the selection there drops the underlined pinyin. */
  composing: boolean;
}

/**
 * The two selection writes that close one undo group: move the selection for real, then collapse it
 * where it already was. Exported because both the component and the engine probe have to agree.
 *
 * `setSelectionRange(caret, caret)` is not enough. Measured on the same page with the same handler
 * (`.pi/bin/hitprobe/undo-real-draft.html`, R0e against R0f): eight characters came back as TWO undo
 * groups with the same-position write and as eight with this one - the engine is free to treat a
 * selection write that changes nothing as a no-op, and a no-op closes nothing. Both writes land in
 * the same task, so there is no frame in which the one-character selection could paint.
 */
export interface Selectable {
  setSelectionRange(from: number, to: number): void;
}

/**
 * The two selection writes that close one undo group: move the selection for real, then collapse it
 * where it already was. Exported because the component and the engine probe have to agree.
 *
 * `setSelectionRange(caret, caret)` is not enough. Measured on the same page with the same handler
 * (`.pi/bin/hitprobe/undo-real-draft.html`, R0e against R0f): eight characters came back as TWO undo
 * groups with the same-position write and as eight with this one - the engine is free to treat a
 * selection write that changes nothing as a no-op, and a no-op closes nothing. Both writes land in
 * the same task, so there is no frame in which the one-character selection could paint.
 */
export function closeUndoGroup(target: Selectable, caret: number): void {
  target.setSelectionRange(Math.max(0, caret - 1), caret);
  target.setSelectionRange(caret, caret);
}

/**
 * Whether to re-assert the caret now, which makes the engine start a fresh undo group - the only way
 * to get character-sized `Cmd+Z` steps out of a textarea, since it otherwise coalesces an entire
 * typing run into one group no matter how long the pauses are (measured at 0 / 300 / 900 / 2000 ms).
 *
 * Two exemptions, both deliberate:
 * - composition text: re-asserting the selection mid-IME drops the underlined pinyin, so an open
 *   session is left to the engine. A candidate commit lands as one step, which is one *word* to the
 *   person typing it, and 2-4 characters to the stack.
 * - `historyUndo` / `historyRedo`: an undo replay must not schedule itself as the thing to undo next.
 *
 * See `closeUndoGroup` for the two writes this answer feeds to.
 */
export function shouldCloseUndoGroup(question: UndoGroupQuestion): boolean {
  if (question.composing) return false;
  if (question.inputType.includes("Composition")) return false;
  if (question.inputType.startsWith("history")) return false;
  return question.charsSinceGroup > 0;
}
