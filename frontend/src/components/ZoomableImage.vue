<script setup lang="ts">
import { ZoomIn, ZoomOut } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { tr } from "../i18n";

/** Zoom is measured against the image's intrinsic pixels: 100% = 1 image px per CSS px. */
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

const props = withDefaults(defineProps<{
  src: string;
  alt: string;
  /** The preview dialog brings its own header controls; the inline file preview uses this pill. */
  controls?: boolean;
}>(), { controls: true });

const stage = ref<HTMLElement | null>(null);
const picture = ref<HTMLImageElement | null>(null);
const natural = ref({ width: 0, height: 0 });
const fitScale = ref(1);
/** `null` = fit-to-window (the CSS max-width/max-height path); a number = explicit pixel zoom. */
const zoom = ref<number | null>(null);
const panning = ref(false);

const scale = computed(() => zoom.value ?? fitScale.value);
const percent = computed(() => Math.max(1, Math.round(scale.value * 100)));
const zoomed = computed(() => zoom.value !== null);
const canZoomIn = computed(() => scale.value < MAX_ZOOM - 0.0001);
const canZoomOut = computed(() => scale.value > fitScale.value + 0.0001);
const zoomTitle = computed(() => (zoomed.value ? tr("composer.zoomFit") : tr("composer.zoomActualSize")));
// The frame carries the scaled layout box, so the scroll container still knows how far it can
// pan. The <img> itself stays at its intrinsic size and is only transformed: changing width/height
// on a several-thousand-pixel image made WebKit re-layout/re-rasterise the bitmap on every wheel
// tick, which is the stutter a zoom-in near 200% showed. Transforms are composited, so zooming
// stays smooth and costs no layout of the image pixels.
const frameStyle = computed(() => natural.value.width > 0
  ? {
      width: `${natural.value.width * scale.value}px`,
      height: `${natural.value.height * scale.value}px`,
    }
  : undefined);
const imageStyle = computed(() => ({ transform: `scale(${scale.value})` }));

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function measureFit() {
  const element = stage.value;
  const size = natural.value;
  if (!element || size.width <= 0 || size.height <= 0) return;
  const style = getComputedStyle(element);
  const availableWidth = element.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
  const availableHeight = element.clientHeight - px(style.paddingTop) - px(style.paddingBottom);
  if (availableWidth <= 0 || availableHeight <= 0) return;
  fitScale.value = Math.min(1, availableWidth / size.width, availableHeight / size.height);
  if (zoom.value !== null && zoom.value <= fitScale.value + 0.0005) zoom.value = null;
}

function onImageLoad(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  natural.value = { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
  measureFit();
}

async function applyZoom(next: number, anchor?: { x: number; y: number }) {
  const element = stage.value;
  const image = picture.value;
  if (!element || !image || natural.value.width <= 0) return;
  const current = zoom.value ?? fitScale.value;
  const target = Math.min(MAX_ZOOM, Math.max(fitScale.value, next));
  // Landing on the fitted size means fit mode again: explicit zoom would leave the stage
  // start-aligned and report a needless pixel size.
  if (target <= fitScale.value + 0.0005) {
    await resetZoom();
    return;
  }
  if (Math.abs(target - current) < 0.0005) return;

  const stageRect = element.getBoundingClientRect();
  const point = anchor ?? {
    x: stageRect.left + element.clientWidth / 2,
    y: stageRect.top + element.clientHeight / 2,
  };
  const before = image.getBoundingClientRect();
  const ratioX = before.width > 0 ? (point.x - before.left) / before.width : 0.5;
  const ratioY = before.height > 0 ? (point.y - before.top) / before.height : 0.5;

  zoom.value = target;
  await nextTick();
  if (!stage.value || !picture.value) return;
  const after = picture.value.getBoundingClientRect();
  // Keep the image point that was under the pointer/cursor pinned there after the resize.
  stage.value.scrollLeft -= point.x - ratioX * after.width - after.left;
  stage.value.scrollTop -= point.y - ratioY * after.height - after.top;
}

async function resetZoom() {
  if (zoom.value === null) return;
  zoom.value = null;
  await nextTick();
  const element = stage.value;
  if (element) {
    element.scrollLeft = 0;
    element.scrollTop = 0;
  }
}

function zoomIn() {
  const current = zoom.value ?? fitScale.value;
  void applyZoom(current * ZOOM_STEP);
}

function zoomOut() {
  const current = zoom.value ?? fitScale.value;
  void applyZoom(current / ZOOM_STEP);
}

/** The header percentage (and a double-click on the image) toggles fit <=> 100%. */
function toggleZoom() {
  if (zoomed.value) void resetZoom();
  else void applyZoom(1);
}

// Wheel/pinch streams arrive faster than a frame. One applyZoom reads two rects and changes the
// scroll offset, so doing that per event on a 20k-pixel image is what makes the last few zoom
// steps feel sticky. The first event in a frame applies at once (a single notch must respond),
// the rest collapse into one rAF update using the last pointer position.
let pendingZoom: { scale: number; anchor?: { x: number; y: number } } | null = null;
let zoomFrame = 0;
let zoomFrameIsTimeout = false;
let lastZoomAt = 0;

function flushZoom() {
  zoomFrame = 0;
  const pending = pendingZoom;
  pendingZoom = null;
  if (!pending) return;
  lastZoomAt = performance.now();
  void applyZoom(pending.scale, pending.anchor);
}

function requestZoom(target: number, anchor?: { x: number; y: number }) {
  pendingZoom = { scale: target, anchor };
  const now = performance.now();
  if (!zoomFrame && now - lastZoomAt >= 16) {
    lastZoomAt = now;
    pendingZoom = null;
    void applyZoom(target, anchor);
    return;
  }
  if (zoomFrame) return;
  if (typeof requestAnimationFrame === "function") {
    zoomFrameIsTimeout = false;
    zoomFrame = requestAnimationFrame(flushZoom);
  } else {
    zoomFrameIsTimeout = true;
    zoomFrame = window.setTimeout(flushZoom, 16);
  }
}

function onWheel(event: WheelEvent) {
  // A plain two-finger swipe is a pan, not a zoom: leave it to the stage's native scrolling,
  // exactly like dragging. Zoom only when the pointer engine reports a pinch — Chromium/WebKit
  // send ctrl+wheel for that; Safari also sends gesture events (handled below).
  if (!event.ctrlKey && !event.metaKey) {
    const element = stage.value;
    if (element && element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight) {
      event.preventDefault();
    }
    return;
  }
  if (natural.value.width <= 0) return;
  event.preventDefault();
  const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015));
  const current = pendingZoom?.scale ?? zoom.value ?? fitScale.value;
  requestZoom(current * Math.min(1.4, Math.max(0.7, factor)), { x: event.clientX, y: event.clientY });
}

// macOS trackpads send pinch gestures as GestureEvents in WebKit; Chrome sends ctrl+wheel.
// The DOM lib shipped with this project does not declare Safari's GestureEvent.
interface PinchGestureEvent extends Event {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

let gestureScale = 1;

function onGestureStart(event: Event) {
  if (natural.value.width <= 0) return;
  event.preventDefault();
  pendingZoom = null;
  gestureScale = zoom.value ?? fitScale.value;
}

function onGestureChange(event: Event) {
  if (natural.value.width <= 0) return;
  event.preventDefault();
  const gesture = event as PinchGestureEvent;
  requestZoom(gestureScale * gesture.scale, { x: gesture.clientX, y: gesture.clientY });
}

const panStart = { x: 0, y: 0, left: 0, top: 0 };
let panPointer: number | null = null;

function startPan(event: PointerEvent) {
  const element = stage.value;
  if (!element || zoom.value === null || event.button !== 0) return;
  if (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight) return;
  panning.value = true;
  panStart.x = event.clientX;
  panStart.y = event.clientY;
  panStart.left = element.scrollLeft;
  panStart.top = element.scrollTop;
  panPointer = event.pointerId;
  element.setPointerCapture?.(event.pointerId);
}

function movePan(event: PointerEvent) {
  const element = stage.value;
  if (!element || !panning.value || event.pointerId !== panPointer) return;
  element.scrollLeft = panStart.left - (event.clientX - panStart.x);
  element.scrollTop = panStart.top - (event.clientY - panStart.y);
}

function endPan(event: PointerEvent) {
  if (!panning.value || event.pointerId !== panPointer) return;
  panning.value = false;
  panPointer = null;
  stage.value?.releasePointerCapture?.(event.pointerId);
}

/** Returns true when the key was a zoom shortcut, so a host-level handler can prevent default. */
function handleKeydown(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key === "+" || event.key === "=") zoomIn();
  else if (event.key === "-" || event.key === "_") zoomOut();
  else if (event.key === "0") void resetZoom();
  else if (event.key === "1") void applyZoom(1);
  else return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function onKeydown(event: KeyboardEvent) {
  handleKeydown(event);
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const element = stage.value;
  const image = picture.value;
  if (image?.complete && image.naturalWidth > 0) {
    natural.value = { width: image.naturalWidth, height: image.naturalHeight };
  }
  if (!element) return;
  measureFit();
  element.addEventListener("wheel", onWheel, { passive: false });
  element.addEventListener("gesturestart", onGestureStart);
  element.addEventListener("gesturechange", onGestureChange);
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => measureFit());
    resizeObserver.observe(element);
  }
});

onBeforeUnmount(() => {
  const element = stage.value;
  if (element) {
    element.removeEventListener("wheel", onWheel);
    element.removeEventListener("gesturestart", onGestureStart);
    element.removeEventListener("gesturechange", onGestureChange);
  }
  if (zoomFrame) {
    if (zoomFrameIsTimeout) clearTimeout(zoomFrame);
    else cancelAnimationFrame(zoomFrame);
    zoomFrame = 0;
  }
  resizeObserver?.disconnect();
  resizeObserver = null;
});

defineExpose({
  // A snapshot keeps the exposed surface plain values; a template ref is not a reactive render
  // context, so exposing the refs themselves would need unwrapping at every call site.
  snapshot: () => ({
    percent: percent.value,
    zoomed: zoomed.value,
    canZoomIn: canZoomIn.value,
    canZoomOut: canZoomOut.value,
  }),
  zoomIn,
  zoomOut,
  resetZoom,
  toggleZoom,
  handleKeydown,
});
</script>

<template>
  <div class="zoomable-image" @keydown="onKeydown">
    <div
      ref="stage"
      class="zoomable-image-stage"
      :class="{ 'is-zoomed': zoomed, 'is-panning': panning }"
      tabindex="0"
      role="group"
      :aria-label="props.alt"
      @pointerdown="startPan"
      @pointermove="movePan"
      @pointerup="endPan"
      @pointercancel="endPan"
    >
      <div class="zoomable-image-frame" :style="frameStyle">
        <img
          ref="picture"
          :src="props.src"
          :alt="props.alt"
          :style="imageStyle"
          draggable="false"
          @load="onImageLoad"
          @dragstart.prevent
          @dblclick.prevent="toggleZoom"
        />
      </div>
    </div>
    <div v-if="props.controls" class="zoomable-image-controls" @pointerdown.stop @dblclick.stop>
      <button
        class="zoom-button"
        type="button"
        :title="tr('composer.zoomOut')"
        :aria-label="tr('composer.zoomOut')"
        :disabled="!canZoomOut"
        @click="zoomOut"
      >
        <ZoomOut :size="15" aria-hidden="true" />
      </button>
      <button
        class="zoom-button zoom-level"
        type="button"
        :title="zoomTitle"
        :aria-label="`${percent}% · ${zoomTitle}`"
        @click="toggleZoom"
      >
        {{ percent }}%
      </button>
      <button
        class="zoom-button"
        type="button"
        :title="tr('composer.zoomIn')"
        :aria-label="tr('composer.zoomIn')"
        :disabled="!canZoomIn"
        @click="zoomIn"
      >
        <ZoomIn :size="15" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
