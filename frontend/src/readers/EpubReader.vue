<script setup lang="ts">
import { ChevronLeft, ChevronRight, List, LoaderCircle, Search } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { tr } from "../i18n";
import { vSpin } from "../utils/spin";
import SearchPopover from "../components/SearchPopover.vue";
import ReaderSettingsMenu from "./ReaderSettingsMenu.vue";
import type { FoliateSection } from "foliate-js/view.js";
import { THEME_COLORS, readerSettings } from "./readerSettings";
import { readPosition, usePositionFlush, writePosition } from "./readingPositions";
import { useDismiss } from "./useDismiss";
import type { FoliateLocation, FoliateTocItem, FoliateView } from "foliate-js/view.js";

/**
 * An EPUB reader built on foliate-js.
 *
 * foliate-js renders a reflowable book as an iframe whose document is laid out into CSS columns and
 * paged by translating it, so a page turn is a transform rather than a re-layout. Its zip loader
 * reads entries on demand (`blob.slice`), so a 50MB illustrated book never lands in memory as a
 * whole — the reason this library was chosen over epub.js, which parses the archive up front.
 *
 * The library is `not stable` by its own README, so it is pinned to an exact version and only
 * `view.js` is imported: `view.js` dispatches on the file's own magic (zip → EPUB) and never touches
 * the PDF adapter, which is why the PDF side can be pdf.js directly.
 */
const props = withDefaults(defineProps<{
  /** Either `/workspace-file?…` or a data URL for workspaces whose bytes cannot be streamed. */
  src: string;
  name: string;
  /** Stable per document (workspace + path), never the tab id: the position outlives the tab. */
  positionKey?: string;
}>(), { positionKey: "" });

const emit = defineEmits<{ relocate: [location: string, fraction: number] }>();

const WHEEL_THRESHOLD = 60;
/** A one-letter query in a long book must not turn the panel into a section-walking spinner. */
const MAX_SEARCH_HITS = 300;
const WHEEL_COOLDOWN_MS = 320;

const loading = ref(true);
const failure = ref<"" | "unsupported" | "load">("");
const fraction = ref(0);
const tocOpen = ref(false);
const toc = shallowRef<FoliateTocItem[]>([]);
const activeLabel = ref("");
const host = ref<HTMLElement | null>(null);
const searchButton = ref<HTMLElement | null>(null);
const root = ref<HTMLElement | null>(null);
const settingsMenu = ref<{ close: () => void } | null>(null);

// Search state. `searchHit` is an index into `hits`; the query is committed by Enter, the same way
// the Markdown preview commits it, because scanning every section of a book per keystroke is not
// something a text field should do.
const searchOpen = ref(false);
const searchQuery = ref("");
const searchPopover = ref<{ focus: () => void } | null>(null);
const hits = ref<{ cfi: string; label: string; excerpt: string }[]>([]);
const searchHit = ref(0);
const searching = ref(false);
const searchProgress = ref(0);

let view: FoliateView | undefined;
let destroyed = false;
/**
 * The book lives in an iframe, so `pointerdown` and `keydown` inside it never reach this document.
 * Without listeners on the book's own document, clicking the page (or pressing ⌘F while reading)
 * did nothing: the dismiss handler only ever saw presses on the reader's own chrome, which is why
 * the panels closed "above and to the left" of them and nowhere else.
 */
let watchedDocument: Document | undefined;
const warmedSections = new Set<string>();
let searchGeneration = 0;
let wheelLockedUntil = 0;
let wheelAccumulator = 0;

const hasToc = computed(() => toc.value.length > 0);
const colors = computed(() => THEME_COLORS[readerSettings.theme]);
const pageStyles = computed(() => {
  const { page, ink, muted } = colors.value;
  const family = readerSettings.fontFamily ? `font-family: ${readerSettings.fontFamily};` : "";
  return `
  @namespace epub "http://www.idpf.org/2007/ops";
  html {
    color-scheme: only light;
    background: ${page};
    /* foliate reads this when it repaints the area around the page. Without it the repaint uses
       the background captured when the view was created, so a theme change left the first page
       half-painted until the next turn rebuilt the view. */
    --theme-bg-color: ${page};
  }
  body {
    color: ${ink};
    ${family}
    font-size: ${readerSettings.fontSize}px;
    line-height: ${readerSettings.lineHeight};
    background: ${page};
  }
  a:link, a:visited { color: ${muted}; }
  p, li, blockquote, dd {
    line-height: ${readerSettings.lineHeight};
    text-align: start;
    widows: 2;
    orphans: 2;
    hyphens: manual;
  }
  [align="left"] { text-align: left; }
  [align="right"] { text-align: right; }
  [align="center"] { text-align: center; }
  [align="justify"] { text-align: justify; }
  pre { white-space: pre-wrap !important; }
  img { max-width: 100% !important; height: auto !important; }
  aside[epub|type~="endnote"], aside[epub|type~="footnote"],
  aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
`;
});

const flattenToc = (items: FoliateTocItem[], depth = 0): { label: string; href: string; depth: number }[] =>
  items.flatMap((item) => [
    { label: item.label, href: item.href, depth },
    ...flattenToc(item.subitems ?? [], depth + 1),
  ]);

/**
 * `setStyles` only reaches documents that exist *after* it is called — the paginator stores the CSS
 * for later views and applies it to the current one only when it has one. Calling it after `init()`
 * therefore styled every page except the first, which is why the cover kept the book's own
 * stretching rules. Every call site below goes through here so the order cannot drift again.
 */
const applyStyles = () => view?.renderer?.setStyles?.(pageStyles.value);

type RendererElement = HTMLElement & { atEnd?: boolean; atStart?: boolean };

const rendererElement = (): RendererElement | undefined => view?.renderer as RendererElement | undefined;

/**
 * Animation is chosen per turn, not globally.
 *
 * Inside a section the paginator only translates the existing iframe, so a 300ms ease is free. A
 * turn that crosses into the next section replaces the iframe's document, and animating that slides
 * an empty page into view before the text arrives — the flicker that made turning feel broken.
 * `atEnd`/`atStart` tell us which kind of turn this is before it happens.
 */
const animateTurn = (delta: number) => {
  const element = rendererElement();
  if (!element) return;
  const crossing = delta > 0 ? element.atEnd === true : element.atStart === true;
  if (readerSettings.animateTurns && !crossing) element.setAttribute("animated", "");
  else element.removeAttribute("animated");
};

/**
 * Calibre-generated covers are a single `<image>` inside an SVG sized `100% × 100%` with
 * `preserveAspectRatio="none"`, i.e. "stretch to whatever box the reader gives me". That is wrong in
 * any window whose aspect differs from the book's page size. Restoring aspect preservation keeps the
 * cover rectangular and letterboxes it, which is what every other reader shows.
 */
const repairStretchedCovers = (doc: Document) => {
  for (const svg of Array.from(doc.querySelectorAll("svg"))) {
    if (svg.getAttribute("preserveAspectRatio") !== "none") continue;
    if (svg.querySelectorAll("image").length !== 1) continue;
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  }
};

const onLoad = (event: Event) => {
  const doc = (event as CustomEvent<{ doc?: Document }>).detail?.doc;
  if (!doc) return;
  repairStretchedCovers(doc);
  // The paginator creates a fresh document per section, so the listeners have to follow it.
  watchBookDocument();
};

const onRelocate = (event: Event) => {
  const detail = (event as CustomEvent<FoliateLocation>).detail ?? {};
  fraction.value = detail.fraction ?? 0;
  activeLabel.value = detail.tocItem?.label ?? "";
  if (detail.cfi) {
    writePosition(props.positionKey, { cfi: detail.cfi });
    emit("relocate", detail.cfi, fraction.value);
  }
  watchBookDocument();
  if (typeof detail.index === "number") {
    warmSection(detail.index + 1);
    warmSection(detail.index - 1);
  }
};

/** A book may link to the web. Cancelling keeps the reader inside the inspector. */
const onExternalLink = (event: Event) => {
  event.preventDefault();
};

const open = async () => {
  failure.value = "";
  loading.value = true;
  try {
    // Imported on first use: a few hundred KB of renderers nobody needs while the tree is on screen.
    const { FoliateView } = await import("foliate-js/view.js");
    if (typeof customElements.get("foliate-view") === "undefined") {
      customElements.define("foliate-view", FoliateView);
    }
    const response = await fetch(props.src);
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
    const blob = await response.blob();
    if (destroyed) return;
    const file = new File([blob], props.name.split(/[\\/]/).pop() || "book.epub", {
      type: blob.type || "application/epub+zip",
    });

    const element = document.createElement("foliate-view") as FoliateView;
    element.setAttribute("exportparts", "head,foot,filter,container");
    element.style.display = "block";
    element.style.width = "100%";
    element.style.height = "100%";
    host.value?.replaceChildren(element);
    view = element;
    element.addEventListener("relocate", onRelocate as EventListener);
    element.addEventListener("load", onLoad as EventListener);
    element.addEventListener("external-link", onExternalLink as unknown as EventListener);

    await element.open(file);
    if (destroyed) {
      element.close();
      return;
    }
    // Before `init()`: see the note on `applyStyles`. Ordering, not the value, was the bug.
    applyStyles();
    toc.value = (element.book?.toc ?? []) as FoliateTocItem[];
    // Not `init({})`: with no location it calls `next()` and lands on the *second* page of the
    // spine, and `showTextStart` jumps to the `bodymatter` landmark, which skips the cover entirely.
    const saved = readPosition(props.positionKey);
    if (saved?.cfi) await element.init({ lastLocation: saved.cfi });
    else await element.goTo(0);
    loading.value = false;
    await nextTick();
    applyStyles();
    watchBookDocument();
  } catch (error) {
    if (destroyed) return;
    loading.value = false;
    failure.value = String((error as Error)?.name ?? "").includes("Unsupported") ? "unsupported" : "load";
  }
};

const turn = (delta: number) => {
  if (!view || loading.value) return;
  animateTurn(delta);
  if (delta < 0) void view.prev();
  else void view.next();
};

/** Both floating panels, closed from either document. */
const closeOverlays = () => {
  if (searchOpen.value) closeSearch();
  settingsMenu.value?.close();
};

const onBookPointerDown = () => { closeOverlays(); };

/** Keyboard inside the book is the same contract as keyboard in the reader: ⌘F, arrows, paging. */
const onBookKeydown = (event: KeyboardEvent) => onKeydown(event);

const watchBookDocument = () => {
  const doc = view?.renderer?.getContents?.()[0]?.doc;
  if (!doc || doc === watchedDocument) return;
  watchedDocument?.removeEventListener("pointerdown", onBookPointerDown);
  watchedDocument?.removeEventListener("keydown", onBookKeydown as EventListener);
  watchedDocument = doc;
  doc.addEventListener("pointerdown", onBookPointerDown);
  doc.addEventListener("keydown", onBookKeydown as EventListener);
};

/**
 * Builds the adjacent sections' blob URLs ahead of the turn.
 *
 * `#createView()` in the paginator destroys the current view *before* the next section's iframe is
 * loaded, so crossing a section boundary is always a moment with nothing to show. The data work
 * (unzip, parse, fetch the section's resources) is the slow half of that moment; doing it while the
 * reader is still on the previous page leaves only the iframe load itself.
 */
const warmSection = (index: number) => {
  const section: FoliateSection | undefined = view?.book?.sections?.[index];
  if (!section?.id || warmedSections.has(section.id) || typeof section.load !== "function") return;
  warmedSections.add(section.id);
  setTimeout(() => {
    if (destroyed) return;
    void Promise.resolve(section.load?.()).catch(() => { warmedSections.delete(section.id); });
  }, 0);
};

const goToLocation = (href: string) => {
  if (!view) return;
  if (readerSettings.tocAutoClose) tocOpen.value = false;
  void view.goTo(href);
};

const onWheel = (event: WheelEvent) => {
  if (!readerSettings.wheelPaging || loading.value || failure.value) return;
  // Horizontal wheels are the book's own business; only vertical intent turns a page.
  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : 0;
  if (!delta) return;
  event.preventDefault();
  const now = Date.now();
  if (now < wheelLockedUntil) return;
  wheelAccumulator += delta;
  if (Math.abs(wheelAccumulator) < WHEEL_THRESHOLD) return;
  const direction = wheelAccumulator > 0 ? 1 : -1;
  wheelAccumulator = 0;
  wheelLockedUntil = now + WHEEL_COOLDOWN_MS;
  turn(direction);
};

const onKeydown = (event: KeyboardEvent) => {
  // ⌘F belongs to the reader while a book is on screen. ConversationPane and the Markdown preview
  // both step aside for `activeDocumentReaderVisible`, so exactly one of them opens a search box.
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
    turn(-1);
  } else if (event.key === "ArrowRight" || event.key === "PageDown") {
    event.preventDefault();
    turn(1);
  }
};

const stopSearch = () => {
  searchGeneration += 1;
  searching.value = false;
  hits.value = [];
  searchHit.value = 0;
  view?.clearSearch?.();
};

const closeSearch = () => {
  searchOpen.value = false;
  searchQuery.value = "";
  stopSearch();
};

const resultLabel = computed(() => {
  if (!searchQuery.value.trim()) return "";
  if (searching.value) return tr("reader.searching", { percent: Math.round(searchProgress.value * 100) });
  if (!hits.value.length) return tr("reader.noResults");
  return `${searchHit.value + 1} / ${hits.value.length}`;
});

const goToHit = (index: number) => {
  const hit = hits.value[index];
  if (!hit || !view) return;
  searchHit.value = index;
  void view.goTo(hit.cfi);
};

/** `view.search` is an async generator over sections; a new query abandons the previous one. */
const runSearch = async (query: string) => {
  stopSearch();
  if (!query.trim() || !view) return;
  const generation = searchGeneration;
  searching.value = true;
  searchProgress.value = 0;
  try {
    for await (const result of view.search({ query }) as AsyncGenerator<Record<string, unknown> | "done">) {
      if (generation !== searchGeneration || destroyed) return;
      if (result === "done") break;
      const progress = result.progress;
      if (typeof progress === "number") searchProgress.value = progress;
      const subitems = result.subitems as { cfi: string; excerpt?: { pre?: string; match?: string; post?: string } }[] | undefined;
      if (Array.isArray(subitems) && subitems.length) {
        const label = typeof result.label === "string" ? result.label : "";
        hits.value = [...hits.value, ...subitems.map((item) => ({
          cfi: item.cfi,
          label,
          excerpt: `${item.excerpt?.pre ?? ""}${item.excerpt?.match ?? ""}${item.excerpt?.post ?? ""}`,
        }))].slice(0, MAX_SEARCH_HITS);
        // Deliberately no jump here: `search()` is still walking sections, and moving the renderer
        // underneath it makes foliate tear down the view it is currently creating ("Right side of
        // assignment cannot be destructured"). The first hit is opened once the walk has finished.
        if (hits.value.length >= MAX_SEARCH_HITS) break;
      }
    }
    if (generation === searchGeneration && !destroyed && hits.value.length) goToHit(0);
  } finally {
    if (generation === searchGeneration) searching.value = false;
  }
};

const openSearch = () => {
  searchOpen.value = true;
  void nextTick(() => searchPopover.value?.focus());
};

watch(searchQuery, (query) => { void runSearch(query).catch(() => { searching.value = false; }); });
watch(() => readerSettings.theme, () => applyStyles());
watch(() => [readerSettings.fontFamily, readerSettings.fontSize, readerSettings.lineHeight], () => applyStyles());
watch(() => readerSettings.animateTurns, () => {
  if (!readerSettings.animateTurns) rendererElement()?.removeAttribute("animated");
});
watch(() => props.src, () => {
  view?.close();
  view = undefined;
  toc.value = [];
  fraction.value = 0;
  stopSearch();
  void open();
});

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
  host.value?.addEventListener("wheel", onWheel, { passive: false });
});

onBeforeUnmount(() => {
  destroyed = true;
  searchGeneration += 1;
  watchedDocument?.removeEventListener("pointerdown", onBookPointerDown);
  watchedDocument?.removeEventListener("keydown", onBookKeydown as EventListener);
  watchedDocument = undefined;
  globalThis.removeEventListener("keydown", onKeydown);
  host.value?.removeEventListener("wheel", onWheel);
  view?.close();
  view = undefined;
  host.value?.replaceChildren();
});
</script>

<template>
  <div ref="root" class="epub-reader" :style="{ background: colors.page }">
    <div v-if="!loading && !failure" class="reader-toolbar">
      <button type="button" :aria-label="tr('files.epubPreviousPage')" :title="tr('files.epubPreviousPage')" @click="turn(-1)"><ChevronLeft :size="15" /></button>
      <button type="button" :aria-label="tr('files.epubNextPage')" :title="tr('files.epubNextPage')" @click="turn(1)"><ChevronRight :size="15" /></button>
      <span class="epub-reader-label">{{ activeLabel || name }}</span>
      <span class="reader-spacer" />
      <button v-if="hasToc" type="button" :class="{ 'is-active': tocOpen }" :aria-expanded="tocOpen" :aria-label="tr('files.epubContents')" :title="tr('files.epubContents')" @click="tocOpen = !tocOpen"><List :size="15" /></button>
      <button ref="searchButton" type="button" :class="{ 'is-active': searchOpen }" :aria-expanded="searchOpen" :aria-label="tr('reader.search')" :title="tr('reader.search')" @click="searchOpen ? closeSearch() : openSearch()"><Search :size="15" /></button>
      <ReaderSettingsMenu ref="settingsMenu" mode="epub" />
    </div>
    <!-- The host is never behind a `v-if`. foliate-js pages a book by measuring its own box, so a
         host that is absent while `loading` is true gets a detached `foliate-view`: the element
         never connects, the paginator never sees a size, `open()` never resolves, and the reader
         shows "loading" forever. The state below is an overlay for exactly that reason. -->
    <div class="epub-reader-body">
      <nav v-if="tocOpen && hasToc" class="reader-toc" :aria-label="tr('files.epubContents')">
        <button
          v-for="item in flattenToc(toc)"
          :key="`${item.depth}-${item.href}-${item.label}`"
          type="button"
          :style="{ paddingInlineStart: `${10 + item.depth * 12}px` }"
          @click="goToLocation(item.href)"
        >{{ item.label }}</button>
      </nav>
      <div class="epub-reader-stage">
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
        <div ref="host" class="epub-reader-host" />
        <div v-if="searchOpen && hits.length" class="reader-search-results" role="listbox" :aria-label="tr('reader.searchResults')">
          <button
            v-for="(hit, index) in hits"
            :key="hit.cfi"
            type="button"
            role="option"
            :aria-selected="index === searchHit"
            :class="{ 'is-active': index === searchHit }"
            @click="goToHit(index)"
          >
            <span class="reader-search-result-label">{{ hit.label }}</span>
            <span class="reader-search-result-excerpt">{{ hit.excerpt }}</span>
          </button>
        </div>
      </div>
    </div>
    <div v-if="!loading && !failure" class="epub-reader-progress" role="progressbar" :aria-valuenow="Math.round(fraction * 100)" aria-valuemin="0" aria-valuemax="100">
      <span :style="{ width: `${Math.round(fraction * 100)}%` }" />
    </div>
    <div v-if="loading" class="pdf-reader-state reader-overlay">
      <LoaderCircle v-spin :size="18" class="is-spinning" />
      <span>{{ tr("files.epubLoading") }}</span>
    </div>
    <div v-else-if="failure" class="pdf-reader-state pdf-reader-failure reader-overlay">
      <p>{{ failure === 'unsupported' ? tr('files.epubUnsupported') : tr('files.epubLoadFailed') }}</p>
      <slot name="fallback" />
    </div>
  </div>
</template>
