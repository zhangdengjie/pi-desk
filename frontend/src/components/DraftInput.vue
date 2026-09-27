<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";

const props = defineProps<{
  modelValue: string;
  placeholder: string;
  ariaLabel: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const input = ref<HTMLTextAreaElement>();
let lastValue = props.modelValue;

/*
 * The chat draft is typed, not authored. `MarkdownEditor.vue` (milkdown/prosemirror) stays in the
 * tree untouched for any surface that wants in-box rendering, but a draft only ever becomes a
 * string sent to Pi — so paying for a document model meant re-declaring every character-level
 * behaviour the browser already owns: Enter, caret affinity at a line edge, IME, undo, and the
 * serialize/parse round trip that drops leading blank lines and trailing spaces. A textarea settles
 * all of them at once: one Shift+Enter is one "\n" and one line box, and a typed fence stays the
 * literal characters the reader meant to send.
 *
 * The field is deliberately uncontrolled (`:value` is never bound): Vue re-assigning `value` on
 * every keystroke is how caret-jump bugs get born. `onMounted` seeds it and the watcher below
 * writes it whenever the draft changes from outside the field.
 *
 * The exposed names match what `ComposerBar.vue` already calls on its `markdownEditor` ref, so
 * switching the composer surface is a two-line diff on a file upstream touches often.
 */

let lastHeight = -1;
let lastLength = 0;

function resize() {
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
  if (shorter || lastHeight < 0) {
    element.style.height = "auto";
    lastHeight = -1;
  }
  const next = element.scrollHeight;
  if (next === lastHeight) return;
  lastHeight = next;
  element.style.height = `${next}px`;
}

function write(value: string, caret: number | null) {
  const element = input.value;
  lastValue = value;
  if (element && element.value !== value) element.value = value;
  if (value !== props.modelValue) emit("update:modelValue", value);
  void nextTick(() => {
    resize();
    if (!element || caret === null) return;
    element.focus();
    element.setSelectionRange(caret, caret);
  });
}

function onInput(event: Event) {
  const element = event.target as HTMLTextAreaElement;
  lastValue = element.value;
  emit("update:modelValue", element.value);
  resize();
}

function focus() {
  input.value?.focus();
}

function replaceMarkdown(value: string) {
  if (value === (input.value?.value ?? value)) focus();
  else write(value, value.length);
}

// Plain Enter belongs to the host: ComposerBar submits on it. There is no fence to convert and no
// list to continue, so this never claims the key.
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
    const patch = separate && previous && !/\s/.test(previous) ? ` ${text}` : text;
    write(`${field.value.slice(0, from)}${patch}${field.value.slice(to)}`, from + patch.length);
    return true;
  };
}

watch(() => props.modelValue, (value) => {
  if (value === lastValue) return;
  write(value, null);
});

onMounted(() => {
  const element = input.value;
  if (element && element.value !== props.modelValue) element.value = props.modelValue;
  resize();
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
    @input="onInput"
  />
</template>
