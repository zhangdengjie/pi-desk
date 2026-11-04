<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  candidateSplit,
  closeUndoGroup,
  minimalPatch,
  shouldCloseUndoGroup,
} from "../utils/undoableEdit";
const props = defineProps<{
  modelValue: string;
  placeholder: string;
  ariaLabel: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string]; caret: [offset: number] }>();

const input = ref<HTMLTextAreaElement>();
let lastValue = props.modelValue;
// An open IME session owns both the selection and the stack: no caret writes while it runs.
let composing = false;
// The field's content when the current composition started.
let committedFrom = "";

/*
 * The chat draft is typed, not authored. `MarkdownEditor.vue` (milkdown/prosemirror) stays in the
 * tree untouched for any surface that wants in-box rendering, but a draft only ever becomes a
 * string sent to Pi — so paying for a document model meant re-declaring every character-level
 * behaviour the browser already owns: Enter, caret affinity at a line edge, IME, undo, and the
 * serialize/parse round trip that drops leading blank lines and trailing spaces. A textarea settles
 * all of them at once: one Enter is one "\n" and one line box (Cmd+Enter belongs to the host and
 * sends; Shift+Enter is just another newline), and a typed fence stays the literal characters the reader meant to send.
 *
 * The field is deliberately uncontrolled (`:value` is never bound): Vue re-assigning `value` on
 * every keystroke is how caret-jump bugs get born. `onMounted` seeds it and the watcher below
 * writes it whenever the draft changes from outside the field - and "writes" means a
 * selected-range `insertText` / `delete` over the differing part only, because assigning
 * `element.value` discards the undo stack the textarea was chosen for. The measurements behind both
 * choices are in `utils/undoableEdit`.
 *
 * Undo needed one addition on top of that: the engine groups a whole run of typing together no matter
 * how long the pauses are, so one `Cmd+Z` erases everything written, and `onInput` closes the group
 * after every edit so the steps come back one character.
 *
 * The exposed names match what `ComposerBar.vue` already calls on its `markdownEditor` ref, so
 * switching the composer surface is a two-line diff on a file upstream touches often.
 */

let lastHeight = -1;
let lastLength = 0;
// The width the last measurement was taken at - see the note inside `resize`.
let measuredWidth = -1;
// Coalesces the width watcher below to one measurement per frame.
let widthWatcher: ResizeObserver | undefined;
let pendingWidthSync = 0;

function resize(bulk = false) {
  const element = input.value;
  if (!element) return;
  // `field-sizing: content` is what this wants, but WKWebView on macOS 15 is Safari 18 and does not
  // have it (Chrome 123+). Measure instead; `.composer-editor` keeps the 180px cap and scrolls.
  //
  // Every newline used to run `height:auto` + read `scrollHeight` + write the height back - two
  // forced synchronous layouts of the whole shell per keystroke, with a streaming transcript
  // keeping the tree dirty, which is exactly the Enter-key typing stutter. Growth needs no reset:
  // a textarea reports its full content height through `scrollHeight` even while the box still
  // stands at the previous height. Only a shrink has to go through `auto`, because a fixed height
  // clamps `scrollHeight` to `clientHeight` - so the reset stays reserved for deletions, and an
  // unchanged height now skips the style write entirely instead of dirtying the tree for nothing.
  const shorter = element.value.length < lastLength;
  lastLength = element.value.length;
  // `scrollHeight` never reports *less* than `clientHeight`, so a box that grew too tall cannot
  // notice it should shrink, and a box that shrank too small is only noticed by the reader (a second
  // scrollbar inside the field). Both states come from the same blind spot: a re-wrap that arrives
  // with no edit. The width is the trigger, so remember it - a pane resize, the inspector opening, the
  // font-size token, or the container's own scrollbar appearing all change it. A bulk edit (paste,
  // drop, undo) is the other trigger: it can re-wrap the same draft into more or fewer lines in one
  // event, which is how a paste used to leave a blank band under the last line.
  const measure = bulk || shorter || lastHeight < 0 || element.clientWidth !== measuredWidth;
  let held: { scroller: HTMLElement; top: number }[] = [];
  if (measure) {
    // Collapsing to `auto` is only a measurement step, but it is not a private one: for the length of
    // one synchronous task the field really is at its one-line floor, so every scroll container that
    // holds it clamps its `scrollTop` to 0 - and the restored height never brings that offset back.
    // The reader's symptom is the draft jumping to its first line on every deleted character
    // (`.pi/bin/hitprobe/draft-resize.html`: `.composer-editor` 211 -> 0 on one Backspace while the
    // content height never changed, 391px before and after). Nothing paints inside one task, so
    // putting the offsets back after the write is invisible.
    held = scrollAncestors(element).map((scroller) => ({ scroller, top: scroller.scrollTop }));
    element.style.height = "auto";
    lastHeight = -1;
  }
  // Every height write can add or drop the container's own scrollbar, which narrows this field and
  // re-wraps the text - so the number just written is not necessarily the number the reader needs
  // (too short = a second scrollbar inside the box, too tall = a blank band under the last line).
  // Settle against the width the field will really be laid out at; two passes in practice.
  let next = element.scrollHeight;
  for (let pass = 0; pass < 3; pass++) {
    if (pass > 0 && next === lastHeight) break;
    if (pass === 0 && !measure && next === lastHeight) break;
    lastHeight = next;
    element.style.height = `${next}px`;
    if (element.scrollHeight <= element.clientHeight + 1) break;
    next = element.scrollHeight;
  }
  // The field is always exactly as tall as its content, so it has no legitimate internal scroll
  // offset: a non-zero one is leftover from the collapsed measurement, where the caret-reveal scrolled
  // the field itself instead of `.composer-editor`. Left alone it shows as blank space under the last
  // line until something else resets it.
  if (element.scrollTop !== 0) element.scrollTop = 0;
  // Writing a height past the new maximum clamps by itself, so a shrink keeps whatever of the offset
  // still exists instead of teleporting to the top.
  for (const { scroller, top } of held) scroller.scrollTop = top;
  measuredWidth = element.clientWidth;
}

/** The boxes above the field that own a scroll position: only those move when it collapses. */
function scrollAncestors(element: HTMLElement): HTMLElement[] {
  const scrollers: HTMLElement[] = [];
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") scrollers.push(node);
  }
  return scrollers;
}

/**
 * Where the caret sits. The `@` completion has to ask "what is behind the caret", not "what is at
 * the end of the draft" — a newline typed in the middle of a pasted title leaves text after the
 * caret, and an end-anchored match then never fires. The field is the only thing that ever knows the
 * caret, so it reports it: on every edit, on every caret move, and after every programmatic write.
 */
function emitCaret() {
  const element = input.value;
  if (element) emit("caret", element.selectionStart ?? element.value.length);
}

function write(value: string, caret: number | null) {
  const element = input.value;
  lastValue = value;
  if (element && element.value !== value && !applyUndoable(element, value)) {
    // The engine refused the edit (no focus, detached field, or an IME session is mid-commit) and a
    // raw write is the only way to land the text: it costs the undo stack, which beats losing the
    // draft. `Cmd+Z` then stays dead until the person types again - the old, always-raw behaviour.
    if (element) element.value = value;
  }
  if (value !== props.modelValue) emit("update:modelValue", value);
  void nextTick(() => {
    // A programmatic replacement (a picked mention, a draft restored from the store) can re-wrap the
    // draft into a different number of lines in either direction, so it measures instead of assuming growth.
    resize(true);
    if (!element || caret === null) {
      emitCaret();
      return;
    }
    element.focus();
    element.setSelectionRange(caret, caret);
    emitCaret();
  });
}

/**
 * Land `value` in the field without discarding the engine's undo stack: replace only the differing
 * range, through the same editing path a keystroke uses. Measured in both engines
 * (`.pi/bin/hitprobe/undo-battery.html`, V13/V14): a selected-range `insertText` / `delete` is one
 * undo step of its own and everything typed before it is still reachable, while `element.value = …`
 * wipes the stack (V5/V8/V9) - so a `@` mention picked from the file panel used to be the end of
 * `Cmd+Z` for the rest of the draft.
 *
 * Returns false when the edit did not apply, and the caller falls back to a raw write.
 */
function applyUndoable(element: HTMLTextAreaElement, value: string): boolean {
  const patch = minimalPatch(element.value, value);
  if (!patch) return true;
  if (composing) return false;
  // jsdom (the unit tests) and any engine without the editing commands: report "did not apply" and
  // let the caller write the value directly.
  if (typeof document.execCommand !== "function") return false;
  // The command edits whatever is focused, so a field that is not focused cannot take a patch - and
  // focusing it here would steal the caret from the panel that initiated the change (the file panel
  // inserting a mention). Those cases keep the raw write: the person is not typing in this field, so
  // there is no undo stack worth preserving in it.
  if (document.activeElement !== element) return false;
  element.setSelectionRange(patch.from, patch.to);
  // "" through insertText is a no-op in both engines, so a pure deletion needs its own command.
  const applied = patch.text
    ? document.execCommand("insertText", false, patch.text)
    : patch.to === patch.from || document.execCommand("delete");
  return applied;
}

function onCompositionStart() {
  composing = true;
  // The text the candidate is about to replace. `compositionend` diffs against it to find what the
  // IME actually committed, and it is also the state the split has to land back in.
  committedFrom = input.value?.value ?? "";
}

function onCompositionEnd() {
  composing = false;
  splitCommittedCandidate();
}

/**
 * Turn one committed candidate into one undo step per character.
 *
 * A candidate commit is a single `insertText` transaction, so the field's undo stack has exactly one
 * step for it and `Cmd+Z` deletes the whole word - measured (`.pi/bin/hitprobe/undo-cjk-split.html`
 * S0, and round two `undo-cjk-split2.html` over five repeats): the only sequence that gives one
 * character per step *and* no stale step is to take the commit back out with `undo` and write it
 * again one character at a time, closing a group after each (A1: `你好世 -> 你好 -> 你 -> ''`).
 * Replacing the committed range in place (A3) is one step shorter to write but leaves the original
 * delete as an extra step, so a fourth Cmd+Z puts the whole word back.
 *
 * Degrades on any surprise: an empty commit, a candidate that replaced a selection, or an `undo` that
 * does not land where the composition started - in all of those the text is put back exactly as the
 * IME left it and the candidate stays one undo step.
 */
function splitCommittedCandidate() {
  const element = input.value;
  if (!element || typeof document.execCommand !== "function") return;
  const patch = candidateSplit({ before: committedFrom, after: element.value });
  if (!patch) return;
  document.execCommand("undo");
  if (element.value !== committedFrom) {
    // Not the step we meant to be undoing, so put it straight back: a granularity experiment is never
    // allowed to cost the person text.
    document.execCommand("redo");
    return;
  }
  for (const character of patch.text) {
    document.execCommand("insertText", false, character);
    closeUndoGroup(element, element.selectionStart ?? element.value.length);
  }
}

function onInput(event: Event) {
  const element = event.target as HTMLTextAreaElement;
  const inputType =
    typeof (event as InputEvent).inputType === "string"
      ? (event as InputEvent).inputType
      : "";
  const before = lastValue.length;
  lastValue = element.value;
  emit("update:modelValue", element.value);
  emitCaret();
  const touched =
    Math.abs(element.value.length - before) ||
    (/^(insert|delete)/.test(inputType) ? 1 : 0);
  // Bulk edits re-wrap the draft without walking the caret through it: measure instead of assuming growth.
  resize(/^(insertFromPaste|insertFromDrop|insertReplacementText|historyUndo|historyRedo)$/.test(inputType));
  // The engine coalesces a whole run of typing into ONE undo group no matter how long the pauses are
  // (0 / 300 / 900 / 2000 ms measured identical), so a single `Cmd+Z` deletes the entire draft. It
  // closes the group itself the moment the selection moves, and re-asserting the caret where it
  // already sits is invisible, costs no phantom undo steps, and makes each step one character
  // (`.pi/bin/hitprobe/undo-battery.html` V3, and `undo-real-draft.html` P1 against the shipped field).
  // A character typed over an equally long selection moves no length, hence the inputType fallback.
  if (
    shouldCloseUndoGroup({ inputType, charsSinceGroup: touched, composing })
  ) {
    // Not `setSelectionRange(caret, caret)`: the engine may treat a selection write that changes
    // nothing as a no-op, and a no-op closes no undo group. Eight characters came back as TWO undo
    // groups with that form and as eight with `closeUndoGroup` - same page, same handler, measured in
    // `.pi/bin/hitprobe/undo-real-draft.html` (R0e against R0f).
    closeUndoGroup(element, element.selectionStart ?? element.value.length);
  }
}

function focus() {
  input.value?.focus();
}

function replaceMarkdown(value: string, caret = value.length) {
  if (value === (input.value?.value ?? value)) {
    focus();
    input.value?.setSelectionRange(caret, caret);
    emit("caret", caret);
    return;
  }
  // The caller wants the caret after what just landed, and that is also what the patch path leaves
  // behind; `write` only re-asserts it (and focuses) when the text had to go in as a raw write.
  write(value, caret);
}

// Plain Enter and Shift+Enter are the field's own newline, and Cmd+Enter is consumed by ComposerBar
// before it
// reaches us. There is no fence to convert and no list to continue, so this never claims the key.
function handleEnter(): boolean {
  return false;
}

// Clipboard IPC is asynchronous, so keep the selection and never clobber a newer draft with it.
function captureTextInsertion(): (text: string, separate?: boolean) => boolean {
  const element = input.value;
  if (!element) return () => false;
  const from = element.selectionStart ?? element.value.length;
  const to = element.selectionEnd ?? from;
  const previous = from > 0 ? element.value[from - 1] : "";
  const captured = element.value;
  return (text, separate = false) => {
    const field = input.value;
    if (!field || field.value !== captured) return false;
    const patch =
      separate && previous && !/\s/.test(previous) ? ` ${text}` : text;
    write(
      `${field.value.slice(0, from)}${patch}${field.value.slice(to)}`,
      from + patch.length,
    );
    return true;
  };
}

watch(
  () => props.modelValue,
  (value) => {
    if (value === lastValue) return;
    write(value, null);
  },
);

onMounted(() => {
  const element = input.value;
  if (!element) return;
  if (element.value !== props.modelValue) element.value = props.modelValue;
  resize();
  // A re-wrap also arrives with no edit at all: hiding the file panel widens the composer (fewer
  // lines, so the box keeps the old height and shows a blank band), opening it narrows the composer
  // (more lines, so the field overflows itself and gets a second scrollbar next to
  // `.composer-editor`'s). `resize()` only runs on edits, so watch the width. The observer cannot loop:
  // the callback is deferred to the next frame, and `resize()` does nothing unless the width actually
  // differs from the one it measured at - a height write only changes the height.
  if (typeof ResizeObserver !== "function") return;
  widthWatcher = new ResizeObserver(() => {
    if (pendingWidthSync) return;
    pendingWidthSync = requestAnimationFrame(() => {
      pendingWidthSync = 0;
      // A hidden composer measures 0 and would write `height: 0px`; the next edit remeasures anyway.
      if (input.value?.clientWidth) resize();
    });
  });
  widthWatcher.observe(element);
});

onBeforeUnmount(() => {
  widthWatcher?.disconnect();
  widthWatcher = undefined;
  if (pendingWidthSync) cancelAnimationFrame(pendingWidthSync);
  pendingWidthSync = 0;
});

defineExpose({ focus, replaceMarkdown, handleEnter, captureTextInsertion });
</script>

<template>
  <textarea
    ref="input"
    class="draft-input"
    :placeholder="placeholder"
    :aria-label="ariaLabel"
    rows="1"
    enterkeyhint="enter"
    @input="onInput"
    @keyup="emitCaret"
    @click="emitCaret"
    @select="emitCaret"
    @compositionstart="onCompositionStart"
    @compositionend="onCompositionEnd"
  />
</template>
