<script setup lang="ts">
import { ChevronLeft, ChevronRight, List, LoaderCircle, Minus, Plus, Search } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { tr } from "../i18n";
import { vSpin } from "../utils/spin";
import SearchPopover from "../components/SearchPopover.vue";
import ReaderSettingsMenu from "./ReaderSettingsMenu.vue";
import { readPosition, usePositionFlush, writePosition } from "./readingPositions";
import { useDismiss } from "./useDismiss";
import { hasNativePdfSupport, loadPdfEngine, pdfDocumentOptions } from "./pdfEngine";
import "../styles/pdf-text-layer.css";

/**
 * A page-at-a-time PDF reader.
 *
 * The whole reason this exists next to the old `<object>` preview is range loading and memory: the
 * engine never receives the file as one payload, a page is rendered only while it is near the
 * viewport, and rendered pages are evicted once they leave — which keeps the footprint bounded by
 * the window rather than by the book.
 */
const props = withDefaults(defineProps<{
  /** Either `/workspace-file?…` or a data URL for workspaces whose bytes cannot be streamed. */
  src: string;
  name: string;
  /** Stable per document (workspace + path), never the tab id: the position outlives the tab. */
  positionKey?: string;
}>(), { positionKey: "" });

const emit = defineEmits<{ relocate: [page: number] }>();

const LOAD_ERROR = "load-error";
const UNSUPPORTED = "unsupported";
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.2;
/** Pages kept canvassed: the visible window plus this much slack in each direction. */
const KEEP_DISTANCE = 2;
/**
 * Hard ceiling on simultaneously canvassed pages.
 *
 * The window above is derived from the viewport, and a viewport is only meaningful when the reader
 * has a constrained height. If it is ever placed in an auto-height box — a mistaken layout, a
 * future host — `clientHeight` becomes the whole document and the "visible window" is the entire
 * book: 102 pages at 1800×2541 is ~1.8GB of canvas.
 */
const MAX_CANVAS_PAGES = 8;
/** Pixel budget for one page canvas. At 4 bytes per pixel, 4M ≈ 16MB. */
const MAX_CANVAS_PIXELS = 4_000_000;
/** Pages whose size is probed per tick, so a 600-page book does not block the first paint. */
const SIZE_PROBE_BATCH = 24;
/** Ceiling on collected search hits: a one-letter query in a 600-page book must not hang the panel. */
const MAX_SEARCH_HITS = 400;

const failure = ref<"" | typeof LOAD_ERROR | typeof UNSUPPORTED>("");
const loading = ref(true);
const pageCount = ref(0);
const currentPage = ref(1);
const zoom = ref(1);
const fitWidth = ref(0);
/** height ÷ width of each page, in PDF units. Index 0 is page 1. */
const aspects = ref<number[]>([]);
const outlineOpen = ref(false);
const outline = ref<{ title: string; page: number; depth: number }[]>([]);

const searchOpen = ref(false);
const searchQuery = ref("");
const searchPopover = ref<{ focus: () => void } | null>(null);
const hits = ref<{ page: number; snippet: string }[]>([]);
const searchHit = ref(0);
const searching = ref(false);
const searchProgress = ref(0);

const root = ref<HTMLElement | null>(null);
const searchButton = ref<HTMLElement | null>(null);
const scroller = ref<HTMLElement | null>(null);
const hosts = new Map<number, HTMLElement>();
const rendered = new Map<number, { scale: number }>();
/** Page text is extracted once and reused by every later query. */
const pageText = new Map<number, string>();

// Named `pdfDocument`, not `document`: the global `document` is needed all over this file to build
// canvases, and a local binding would shadow it.
let pdfDocument: PDFDocumentProxy | undefined;
let loadingTask: PDFDocumentLoadingTask | undefined;
let destroyed = false;
let frame = 0;
let sizeProbe: Promise<void> | undefined;
let searchGeneration = 0;

const pageWidth = computed(() => Math.max(0, Math.round(fitWidth.value * zoom.value)));
const hasOutline = computed(() => outline.value.length > 0);

const pageHeight = (index: number): number => {
  const aspect = aspects.value[index] ?? aspects.value[0] ?? 1.414;
  return Math.round(pageWidth.value * aspect);
};

const setHost = (page: number, element: Element | null) => {
  if (element instanceof HTMLElement) hosts.set(page, element);
  else hosts.delete(page);
};

/** Destroying a canvas is what actually frees the backing store; dropping the reference is not enough. */
const release = (page: number) => {
  hosts.get(page)?.replaceChildren();
  rendered.delete(page);
};

const releaseAll = () => {
  for (const page of [...rendered.keys()]) release(page);
};

const visibleRange = (): { first: number; last: number } => {
  const element = scroller.value;
  if (!element || pageCount.value === 0) return { first: 1, last: 1 };
  const top = element.scrollTop;
  const bottom = top + element.clientHeight;
  // Every page's height is known, so the visible window is an arithmetic walk rather than a DOM
  // measurement — no layout read per scroll frame.
  let offset = 0;
  let first = pageCount.value;
  for (let index = 0; index < pageCount.value; index += 1) {
    offset += pageHeight(index);
    if (offset >= top) {
      first = index + 1;
      break;
    }
  }
  offset = 0;
  let last = first;
  for (let index = 0; index < pageCount.value; index += 1) {
    offset += pageHeight(index);
    if (offset >= bottom) {
      last = index + 1;
      break;
    }
    last = index + 1;
  }
  return { first, last: Math.max(first, last) };
};

/** Marks the text-layer runs that contain the current query, so a hit is visible where it matters. */
const markSearchHits = (container: HTMLElement) => {
  const needle = searchQuery.value.trim().toLowerCase();
  if (!needle) return;
  for (const span of Array.from(container.querySelectorAll("span"))) {
    if ((span.textContent ?? "").toLowerCase().includes(needle)) span.classList.add("pdf-search-hit");
  }
};

const renderPage = async (pageNumber: number) => {
  if (!pdfDocument || destroyed || !pageCount.value) return;
  const width = pageWidth.value;
  if (!width) return;
  const host = hosts.get(pageNumber);
  if (!host || rendered.get(pageNumber)?.scale === width) return;
  const pdfjs = await loadPdfEngine();
  const page: PDFPageProxy = await pdfDocument.getPage(pageNumber);
  if (destroyed || width !== pageWidth.value) return;

  const base = page.getViewport({ scale: 1 });
  const cssScale = width / base.width;
  const deviceScale = Math.min(globalThis.devicePixelRatio || 1, 2);
  // Clamp the backing store, not the CSS size: the page must still fill `width` CSS pixels, but a
  // 2× DPR copy of a large page is allowed to be rendered at a lower internal resolution.
  const wanted = cssScale * deviceScale;
  const pixels = base.width * wanted * base.height * wanted;
  const renderScale = pixels > MAX_CANVAS_PIXELS ? wanted * Math.sqrt(MAX_CANVAS_PIXELS / pixels) : wanted;
  const viewport = page.getViewport({ scale: renderScale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${Math.round(width * (base.height / base.width))}px`;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", tr("files.pdfPage", { page: pageNumber, total: pageCount.value }));
  const context = canvas.getContext("2d");
  if (!context) return;
  // Track it before awaiting so a second pass does not start the same page again.
  rendered.set(pageNumber, { scale: width });
  try {
    await page.render({ canvas, canvasContext: context, viewport }).promise;
  } catch {
    rendered.delete(pageNumber);
    return;
  }
  if (destroyed || width !== pageWidth.value || !hosts.has(pageNumber)) return;

  const textContainer = document.createElement("div");
  textContainer.className = "textLayer";
  textContainer.style.setProperty("--scale-factor", String(cssScale));
  textContainer.style.setProperty("--user-unit", "1");
  host.replaceChildren(canvas, textContainer);

  // Selection is a bonus, never a reason for a page to stay blank: a text-layer failure (an
  // unusual font program, a broken ToUnicode map) must not take the rendered page with it.
  try {
    const layer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textContainer,
      viewport: page.getViewport({ scale: cssScale }),
    });
    await layer.render();
    markSearchHits(textContainer);
  } catch {
    textContainer.remove();
  }
};

const renderWindow = () => {
  if (destroyed || !pdfDocument) return;
  const { first, last } = visibleRange();
  const from = Math.max(1, first - KEEP_DISTANCE);
  // Never more than the budget, even if the viewport claims to see everything.
  const to = Math.max(from, Math.min(pageCount.value, last + KEEP_DISTANCE, from + MAX_CANVAS_PAGES - 1));
  for (const page of [...rendered.keys()]) {
    if (page < from || page > to) release(page);
  }
  for (let page = from; page <= to; page += 1) void renderPage(page);
  const next = Math.min(pageCount.value, last);
  if (next !== currentPage.value) {
    currentPage.value = next;
    writePosition(props.positionKey, { page: next });
    emit("relocate", next);
  }
};

const scheduleRender = () => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderWindow();
  });
};

const probePageSizes = async () => {
  if (!pdfDocument) return;
  const total = pdfDocument.numPages;
  const next = [...aspects.value];
  for (let start = 2; start <= total; start += SIZE_PROBE_BATCH) {
    if (destroyed) return;
    const batch = [];
    for (let page = start; page < Math.min(total + 1, start + SIZE_PROBE_BATCH); page += 1) {
      batch.push(pdfDocument.getPage(page).then((loaded) => {
        const viewport = loaded.getViewport({ scale: 1 });
        next[page - 1] = viewport.height / viewport.width;
      }).catch(() => undefined));
    }
    await Promise.all(batch);
    if (!destroyed) {
      aspects.value = next.slice(0, total);
      await nextTick();
      renderWindow();
    }
    // Yield to input between batches: a long book must not make scrolling stutter while the
    // placeholder geometry is still being corrected.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const loadOutline = async () => {
  if (!pdfDocument) return;
  try {
    const raw = await pdfDocument.getOutline();
    if (!raw?.length) return;
    const flat: { title: string; page: number; depth: number }[] = [];
    const walk = async (items: typeof raw, depth: number) => {
      for (const item of items) {
        const page = await destinationPage(item.dest);
        if (page) flat.push({ title: item.title || tr("reader.untitledChapter"), page, depth });
        if (item.items?.length) await walk(item.items, depth + 1);
      }
    };
    await walk(raw, 0);
    if (!destroyed) outline.value = flat;
  } catch {
    /* A malformed outline is not a reason to refuse the document. */
  }
};

/** `dest` is either a page reference or a named destination; both resolve to a 1-based page. */
const destinationPage = async (dest: unknown): Promise<number | null> => {
  if (!pdfDocument || dest == null) return null;
  try {
    const explicit = typeof dest === "string" ? await pdfDocument.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const index = await pdfDocument.getPageIndex(explicit[0]);
    return index + 1;
  } catch {
    return null;
  }
};

const measure = () => {
  const element = scroller.value;
  if (!element) return;
  const style = getComputedStyle(element);
  const horizontal = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const width = Math.max(160, element.clientWidth - horizontal);
  if (Math.abs(width - fitWidth.value) <= 1) return;
  fitWidth.value = width;
  releaseAll();
  scheduleRender();
};

const goToPage = async (page: number) => {
  const element = scroller.value;
  if (!element || pageCount.value === 0) return;
  const target = Math.min(Math.max(1, Math.trunc(page)), pageCount.value);
  let offset = 0;
  for (let index = 0; index < target - 1; index += 1) offset += pageHeight(index);
  element.scrollTop = offset;
  currentPage.value = target;
  writePosition(props.positionKey, { page: target });
  emit("relocate", target);
  scheduleRender();
};

const step = (delta: number) => void goToPage(currentPage.value + delta);

const applyZoom = (next: number) => {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(next * 100) / 100));
  if (clamped === zoom.value) return;
  // Keep the reader's eye on the same page: recompute the scroll offset from the new heights.
  const page = currentPage.value;
  zoom.value = clamped;
  releaseAll();
  void nextTick(() => {
    goToPage(page);
    scheduleRender();
  });
};

const resultLabel = computed(() => {
  if (!searchQuery.value.trim()) return "";
  if (searching.value) return tr("reader.searching", { percent: Math.round(searchProgress.value * 100) });
  if (!hits.value.length) return tr("reader.noResults");
  return `${searchHit.value + 1} / ${hits.value.length}`;
});

const stopSearch = () => {
  searchGeneration += 1;
  searching.value = false;
  hits.value = [];
  searchHit.value = 0;
  for (const host of hosts.values()) {
    for (const span of Array.from(host.querySelectorAll(".pdf-search-hit"))) span.classList.remove("pdf-search-hit");
  }
};

const closeSearch = () => {
  searchOpen.value = false;
  searchQuery.value = "";
  stopSearch();
};

const goToHit = (index: number) => {
  const hit = hits.value[index];
  if (!hit) return;
  searchHit.value = index;
  void goToPage(hit.page);
};

const textOfPage = async (page: number): Promise<string> => {
  const cached = pageText.get(page);
  if (cached !== undefined) return cached;
  if (!pdfDocument) return "";
  const loaded = await pdfDocument.getPage(page);
  const content = await loaded.getTextContent();
  const text = content.items
    .map((item) => ("str" in item ? item.str : ""))
    .join("")
    .replace(/\s+/g, " ");
  pageText.set(page, text);
  return text;
};

/**
 * Walks the document once per query. `getTextContent` is cached per page, so the second query of a
 * session only re-scans strings; the first is the expensive one, which is why the field commits on
 * Enter rather than on every keystroke.
 */
const runSearch = async (query: string) => {
  stopSearch();
  const needle = query.trim().toLowerCase();
  if (!needle || !pdfDocument) return;
  const generation = searchGeneration;
  searching.value = true;
  searchProgress.value = 0;
  const found: { page: number; snippet: string }[] = [];
  try {
    for (let page = 1; page <= pageCount.value; page += 1) {
      if (generation !== searchGeneration || destroyed) return;
      const text = await textOfPage(page);
      const haystack = text.toLowerCase();
      let at = haystack.indexOf(needle);
      while (at >= 0 && found.length < MAX_SEARCH_HITS) {
        const start = Math.max(0, at - 30);
        found.push({ page, snippet: `${start > 0 ? "…" : ""}${text.slice(start, at + needle.length + 40).trim()}` });
        at = haystack.indexOf(needle, at + needle.length);
      }
      searchProgress.value = page / pageCount.value;
      // Yield so typing stays responsive on a long document.
      if (page % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      if (found.length >= MAX_SEARCH_HITS) break;
    }
    if (generation !== searchGeneration || destroyed) return;
    hits.value = found;
    if (found.length) goToHit(0);
  } finally {
    if (generation === searchGeneration) searching.value = false;
  }
};

const openSearch = () => {
  searchOpen.value = true;
  void nextTick(() => searchPopover.value?.focus());
};

/** Arrow keys page like the EPUB reader; a form control keeps its own arrow behaviour. */
const onKeydown = (event: KeyboardEvent) => {
  // ⌘F belongs to the reader while a document is on screen; ConversationPane and the Markdown
  // preview both step aside for `activeDocumentReaderVisible`.
  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
    event.preventDefault();
    openSearch();
    return;
  }
  if (event.altKey || event.metaKey || event.ctrlKey) return;
  const target = event.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  if (event.key === "ArrowLeft" || event.key === "PageUp") {
    event.preventDefault();
    step(-1);
  } else if (event.key === "ArrowRight" || event.key === "PageDown") {
    event.preventDefault();
    step(1);
  }
};

let resizeObserver: ResizeObserver | undefined;
let scrollListener: (() => void) | undefined;

const open = async () => {
  failure.value = "";
  loading.value = true;
  try {
    const pdfjs = await loadPdfEngine();
    const task = pdfjs.getDocument(pdfDocumentOptions({ url: props.src }));
    loadingTask = task;
    const loaded = await task.promise;
    if (destroyed) {
      void task.destroy();
      return;
    }
    pdfDocument = loaded;
    pageCount.value = loaded.numPages;
    const first = await loaded.getPage(1);
    const viewport = first.getViewport({ scale: 1 });
    aspects.value = [viewport.height / viewport.width];
    loading.value = false;
    await nextTick();
    measure();
    const savedPage = readPosition(props.positionKey)?.page ?? 1;
    if (savedPage > 1) void goToPage(savedPage);
    sizeProbe = probePageSizes();
    void loadOutline();
  } catch {
    if (destroyed) return;
    loading.value = false;
    // The polyfills make an older WebKit attempt-able, so a failure there is *usually* the engine's
    // own limits rather than the machine's. Only a webview that shipped without the APIs gets the
    // "your system is too old" wording, and only after it has actually failed.
    failure.value = hasNativePdfSupport() ? LOAD_ERROR : UNSUPPORTED;
  }
};

usePositionFlush();
useDismiss(
  () => searchOpen.value,
  () => [
    searchButton.value,
    root.value?.querySelector(".reader-search") ?? null,
    root.value?.querySelector(".reader-search-results") ?? null,
  ],
  () => { closeSearch(); },
);

onMounted(() => {
  void open();
  globalThis.addEventListener("keydown", onKeydown);
  scrollListener = scheduleRender;
  scroller.value?.addEventListener("scroll", scrollListener, { passive: true });
  if (typeof ResizeObserver === "function" && scroller.value) {
    resizeObserver = new ResizeObserver(() => measure());
    resizeObserver.observe(scroller.value);
  }
});

onBeforeUnmount(() => {
  destroyed = true;
  searchGeneration += 1;
  globalThis.removeEventListener("keydown", onKeydown);
  if (frame) cancelAnimationFrame(frame);
  if (scrollListener) scroller.value?.removeEventListener("scroll", scrollListener);
  resizeObserver?.disconnect();
  void sizeProbe;
  releaseAll();
  // `PDFDocumentProxy` has no `destroy()` in 6.x; the loading task owns the worker and the network
  // requests, so releasing the document means aborting the task.
  void loadingTask?.destroy();
  loadingTask = undefined;
  pdfDocument = undefined;
});

watch(searchQuery, (query) => { void runSearch(query); });
watch(() => props.src, () => {
  releaseAll();
  void loadingTask?.destroy();
  loadingTask = undefined;
  pdfDocument = undefined;
  aspects.value = [];
  pageCount.value = 0;
  outline.value = [];
  pageText.clear();
  stopSearch();
  void open();
});
</script>

<template>
  <div ref="root" class="pdf-reader">
    <div v-if="!loading && !failure" class="reader-toolbar">
      <button type="button" :aria-label="tr('files.pdfPreviousPage')" :title="tr('files.pdfPreviousPage')" :disabled="currentPage <= 1" @click="step(-1)"><ChevronLeft :size="15" /></button>
      <span class="reader-pagecount">
        <input
          :value="currentPage"
          class="reader-pageinput"
          type="number"
          min="1"
          :max="pageCount"
          :aria-label="tr('files.pdfGoToPage')"
          @change="goToPage(Number(($event.target as HTMLInputElement).value) || currentPage)"
        />
        <span aria-hidden="true">/ {{ pageCount }}</span>
      </span>
      <button type="button" :aria-label="tr('files.pdfNextPage')" :title="tr('files.pdfNextPage')" :disabled="currentPage >= pageCount" @click="step(1)"><ChevronRight :size="15" /></button>
      <span class="reader-spacer" />
      <button v-if="hasOutline" type="button" :class="{ 'is-active': outlineOpen }" :aria-expanded="outlineOpen" :aria-label="tr('reader.outline')" :title="tr('reader.outline')" @click="outlineOpen = !outlineOpen"><List :size="15" /></button>
      <button ref="searchButton" type="button" :class="{ 'is-active': searchOpen }" :aria-expanded="searchOpen" :aria-label="tr('reader.search')" :title="tr('reader.search')" @click="searchOpen ? closeSearch() : openSearch()"><Search :size="15" /></button>
      <button type="button" :aria-label="tr('files.zoomOut')" :title="tr('files.zoomOut')" :disabled="zoom <= MIN_ZOOM" @click="applyZoom(zoom / ZOOM_STEP)"><Minus :size="15" /></button>
      <button type="button" class="reader-zoomlabel" :aria-label="tr('files.zoomReset')" :title="tr('files.zoomReset')" @click="applyZoom(1)">{{ Math.round(zoom * 100) }}%</button>
      <button type="button" :aria-label="tr('files.zoomIn')" :title="tr('files.zoomIn')" :disabled="zoom >= MAX_ZOOM" @click="applyZoom(zoom * ZOOM_STEP)"><Plus :size="15" /></button>
      <ReaderSettingsMenu mode="pdf" />
    </div>
    <!-- Always mounted, never behind a `v-if`: the scroll listener and the ResizeObserver are bound
         on mount, and a ref that only exists once loading finished leaves both attached to null —
         the first window renders, then scrolling never asks for another page. -->
    <div class="reader-stage">
      <SearchPopover
        v-if="searchOpen"
        ref="searchPopover"
        v-model:query="searchQuery"
        class="reader-search"
        :has-matches="hits.length > 0"
        :result-label="resultLabel"
        :placeholder="tr('reader.searchPlaceholder')"
        @close="closeSearch"
        @next="goToHit(Math.min(hits.length - 1, searchHit + 1))"
        @previous="goToHit(Math.max(0, searchHit - 1))"
      />
      <nav v-if="outlineOpen && hasOutline" class="reader-toc" :aria-label="tr('reader.outline')">
        <button
          v-for="item in outline"
          :key="`${item.depth}-${item.page}-${item.title}`"
          type="button"
          :style="{ paddingInlineStart: `${10 + item.depth * 12}px` }"
          @click="goToPage(item.page)"
        ><span class="reader-toc-page">{{ item.page }}</span>{{ item.title }}</button>
      </nav>
      <div v-if="searchOpen && hits.length" class="reader-search-results" role="listbox" :aria-label="tr('reader.searchResults')">
        <button
          v-for="(hit, index) in hits"
          :key="`${hit.page}-${index}`"
          type="button"
          role="option"
          :aria-selected="index === searchHit"
          :class="{ 'is-active': index === searchHit }"
          @click="goToHit(index)"
        >
          <span class="reader-search-result-label">{{ tr("files.pdfPage", { page: hit.page, total: pageCount }) }}</span>
          <span class="reader-search-result-excerpt">{{ hit.snippet }}</span>
        </button>
      </div>
      <div ref="scroller" class="pdf-reader-scroll">
        <div class="pdf-reader-stack" :style="{ width: `${pageWidth}px` }">
          <div
            v-for="page in pageCount"
            :key="page"
            :ref="(element) => setHost(page, element as Element | null)"
            class="pdf-reader-page"
            :style="{ width: `${pageWidth}px`, height: `${pageHeight(page - 1)}px` }"
          />
        </div>
      </div>
    </div>
    <div v-if="loading" class="pdf-reader-state reader-overlay">
      <LoaderCircle v-spin :size="18" class="is-spinning" />
      <span>{{ tr("files.pdfLoading") }}</span>
    </div>
    <div v-else-if="failure" class="pdf-reader-state pdf-reader-failure reader-overlay">
      <p>{{ failure === UNSUPPORTED ? tr('files.pdfEngineUnsupported') : tr('files.pdfLoadFailed') }}</p>
      <slot name="fallback" />
    </div>
  </div>
</template>
