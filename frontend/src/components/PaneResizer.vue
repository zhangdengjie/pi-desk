<script setup lang="ts">
import { ui } from "../ui/classes";
import { useAppStore } from "../stores/app";
import { onBeforeUnmount } from "vue";

const appStore = useAppStore();

const props = defineProps<{
  side: "left" | "right";
  value: number;
  min: number;
  max: number;
  label: string;
}>();

const emit = defineEmits<{
  resize: [width: number];
  commit: [width: number];
}>();

let startX = 0;
let startWidth = 0;
let currentWidth = 0;
// A pointer can report faster than the display refreshes (120Hz mice, coalesced events), so
// samples are coalesced to one commit per frame. Writing a reactive ref per pointermove -
// which an earlier attempt at a transform-preview did - made the drag *worse*: every event
// became a Vue patch. The width still lands through `resize`, one frame at a time.
let frame = 0;
let pending = -1;

function bounded(width: number): number {
  return Math.min(props.max, Math.max(props.min, Math.round(width)));
}

function move(event: PointerEvent) {
  const delta = props.side === "left" ? event.clientX - startX : startX - event.clientX;
  pending = bounded(startWidth + delta);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (pending < 0) return;
    currentWidth = pending;
    pending = -1;
    emit("resize", currentWidth);
  });
}

// WebKit only: `preventDefault()` on pointerdown does not reliably suppress the
// compatibility mousedown. When one slips through while the document still holds a text
// selection (a double-clicked word in xterm, a copied range in the transcript), WebKit reads
// the press-and-move on the handle as "drag the existing selection" and opens a native
// NSDragging session - from then on every pointermove goes into AppKit's drag loop and JS
// receives none of them. The handle shows the col-resize cursor but the pane is frozen; the
// only observed recoveries were a click elsewhere (collapses the selection) or a native
// window operation (ends the session). Cancelling mousedown at the source is what keeps the
// drag in the pointer-event world, where the rAF coalescing below stays real-time.
function suppressCompatibleMouse(event: MouseEvent) {
  event.preventDefault();
}

function stop() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  if (pending >= 0) {
    currentWidth = pending;
    pending = -1;
  }
  document.documentElement.classList.remove("is-resizing-pane");
  appStore.setPaneResizing(false);
  window.removeEventListener("pointermove", move);
  window.removeEventListener("pointerup", stop);
  window.removeEventListener("pointercancel", stop);
  window.removeEventListener("mousedown", suppressCompatibleMouse, true);
  emit("commit", currentWidth);
}

function start(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  startX = event.clientX;
  startWidth = props.value;
  currentWidth = props.value;
  pending = -1;
  // Belt and braces: if a previous drag ended without its rAF ever running (a paused or
  // throttled frame), `frame` would stay non-zero and `move()` would drop every sample of
  // the next drag. A fresh gesture always starts unarmed.
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  document.documentElement.classList.add("is-resizing-pane");
  appStore.setPaneResizing(true);
  // Route the whole gesture to this element: even if the pointer slides over an embedded
  // surface (native browser pane, iframe) mid-drag, the events keep coming here.
  const handle = event.currentTarget as HTMLElement | null;
  try {
    handle?.setPointerCapture(event.pointerId);
  } catch {
    // capture is a hardening, not a requirement - the window listeners below still work
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop, { once: true });
  window.addEventListener("pointercancel", stop, { once: true });
  window.addEventListener("mousedown", suppressCompatibleMouse, true);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const visualDelta = event.key === "ArrowRight" ? 12 : -12;
  const width = bounded(props.value + (props.side === "left" ? visualDelta : -visualDelta));
  emit("resize", width);
  emit("commit", width);
}

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame);
  document.documentElement.classList.remove("is-resizing-pane");
  appStore.setPaneResizing(false);
  window.removeEventListener("pointermove", move);
  window.removeEventListener("pointerup", stop);
  window.removeEventListener("pointercancel", stop);
  window.removeEventListener("mousedown", suppressCompatibleMouse, true);
});
</script>

<template>
  <div
    class="pane-resizer"
    :class="[ui.root, `is-${side}`]"
    :style="side === 'left' ? { '--sidebar-width': `${value}px` } : { '--inspector-width': `${value}px` }"
    role="separator"
    aria-orientation="vertical"
    :aria-label="label"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="value"
    tabindex="0"
    draggable="false"
    @pointerdown="start"
    @mousedown.prevent
    @dragstart.prevent
    @keydown="onKeydown"
  />
</template>
