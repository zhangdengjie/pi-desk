<script setup lang="ts">
/**
 * The small toolbar that appears over a text selection in the transcript: 引用到输入框 / 复制.
 *
 * Why it exists: quoting a passage is how a reader argues with one paragraph instead of the whole
 * answer, and until now the only ways were to retype it or copy it into the draft by hand. Every
 * mainstream harness (Claude's desktop app, ChatGPT, Cursor) offers the same gesture.
 *
 * Three rules keep it from fighting with selection itself:
 *   - it never calls `preventDefault` on pointer events while the reader is dragging;
 *   - the buttons cancel `pointerdown`, so the click cannot collapse the selection before the
 *     handler reads it;
 *   - it hides on scroll rather than trying to follow, because a fixed overlay anchored to a rect
 *     that is moving under it drifts away from the words it points at.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { tr } from "../i18n";
import { useAppStore } from "../stores/app";
import { normalizeSelectionText } from "../utils/selectionQuote";

const appStore = useAppStore();
const visible = ref(false);
const rawText = ref("");
const copied = ref(false);
const anchorTop = ref(0);
const anchorLeft = ref(0);
/** Above the selection unless there is no room (the selection starts under the title bar). */
const placement = ref<"above" | "below">("above");
const bar = ref<HTMLElement>();

let frame = 0;
let copiedTimer: number | undefined;

const preview = computed(() => normalizeSelectionText(rawText.value, 60));

function reset() {
  visible.value = false;
  rawText.value = "";
  copied.value = false;
  if (copiedTimer !== undefined) {
    window.clearTimeout(copiedTimer);
    copiedTimer = undefined;
  }
}

/** The last rect of the range, i.e. where the selection ends - the anchor macOS popovers use. */
function lastRect(range: Range): DOMRect | undefined {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  return rects[rects.length - 1] ?? (range.getBoundingClientRect().width > 0 ? range.getBoundingClientRect() : undefined);
}

/** The element the selection lives in, or undefined when it is not transcript prose. */
function transcriptElement(selection: Selection): Element | undefined {
  if (selection.rangeCount !== 1 || selection.isCollapsed) return undefined;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  if (!element) return undefined;
  // The composer, a rename field or a dialog's own editor own their selections.
  if (element.closest("input, textarea, select, [contenteditable='true']")) return undefined;
  if (element.closest("[role='dialog'], .settings-dialog, .conversation-search")) return undefined;
  return element.closest(".timeline") ? element : undefined;
}

function update() {
  frame = 0;
  if (!appStore.activeThreadId) return reset();
  const selection = window.getSelection();
  if (!selection || !transcriptElement(selection)) return reset();
  const text = selection.toString();
  if (!normalizeSelectionText(text)) return reset();

  const range = selection.getRangeAt(0);
  const rect = lastRect(range);
  if (!rect) return reset();

  // A rect that has scrolled out of the pane is not something to point at. A zero-height pane is
  // what a document without layout reports (jsdom, a pane that has not been measured yet) - there is
  // nothing to be outside of, so the check only runs when the pane has real geometry.
  const pane = document.querySelector(".timeline")?.getBoundingClientRect();
  if (pane && pane.height > 0 && (rect.bottom < pane.top || rect.top > pane.bottom)) return reset();

  rawText.value = text;
  const half = (bar.value?.offsetWidth ?? 190) / 2;
  const min = half + 12;
  const max = window.innerWidth - half - 12;
  anchorLeft.value = Math.min(Math.max(rect.left + rect.width / 2, min), max);
  placement.value = rect.top > 96 ? "above" : "below";
  anchorTop.value = placement.value === "above" ? rect.top - 8 : rect.bottom + 8;
  visible.value = true;
}

function scheduleUpdate() {
  if (frame) return;
  frame = requestAnimationFrame(update);
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!visible.value) return;
  const target = event.target;
  if (target instanceof Element && target.closest(".selection-actions")) return;
  reset();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && visible.value) reset();
}

async function copy() {
  const text = normalizeSelectionText(rawText.value);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // `navigator.clipboard` can be refused in a webview without a user gesture chain; the
    // selection itself is still there, so a hidden textarea + execCommand is a safe last resort.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position: fixed; top: -1000px; left: -1000px; opacity: 0;";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  copied.value = true;
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    copied.value = false;
    copiedTimer = undefined;
  }, 1400);
}

async function quote() {
  const text = rawText.value;
  if (!normalizeSelectionText(text)) return;
  appStore.insertQuotedSelection(text);
  // The quote lives in the draft; the composer is where the reader wants to be next.
  reset();
  await nextTick();
  window.dispatchEvent(new CustomEvent("pidesk:focus-composer"));
}

onMounted(() => {
  document.addEventListener("selectionchange", scheduleUpdate);
  document.addEventListener("pointerup", scheduleUpdate);
  document.addEventListener("keyup", scheduleUpdate);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("scroll", reset, true);
  window.addEventListener("resize", reset);
});

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame);
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
  document.removeEventListener("selectionchange", scheduleUpdate);
  document.removeEventListener("pointerup", scheduleUpdate);
  document.removeEventListener("keyup", scheduleUpdate);
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("scroll", reset, true);
  window.removeEventListener("resize", reset);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="bar"
      class="selection-actions"
      :data-placement="placement"
      role="toolbar"
      :aria-label="tr('selection.toolbar')"
      :style="{ top: `${anchorTop}px`, left: `${anchorLeft}px` }"
      @pointerdown.prevent
    >
      <button class="selection-action" type="button" :title="preview ? tr('selection.quotePreview', { text: preview }) : tr('selection.quote')" @click="void quote()">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 3.5h10M3 7h10M3 10.5h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        <span>{{ tr("selection.quote") }}</span>
      </button>
      <button class="selection-action" type="button" :title="tr('selection.copy')" @click="void copy()">
        <svg v-if="!copied" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M10.5 5.5v-1a1.6 1.6 0 0 0-1.6-1.6H3.6A1.6 1.6 0 0 0 2 4.5v5.3a1.6 1.6 0 0 0 1.6 1.6h1" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
        <svg v-else viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <span>{{ copied ? tr("selection.copied") : tr("selection.copy") }}</span>
      </button>
    </div>
  </Teleport>
</template>