<script setup lang="ts">
import { ChevronLeft, ChevronRight, List, LoaderCircle, Minus, Plus } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { tr } from "../i18n";
import { vSpin } from "../utils/spin";
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
  /** EPUB CFI to restore when the tab is reopened. */
  initialLocation?: string;
  /** Body font size in px, applied inside the iframe. */
  fontSize?: number;
}>(), { initialLocation: "", fontSize: 18 });

const emit = defineEmits<{ relocate: [location: string, fraction: number] }>();

const MIN_FONT = 12;
const MAX_FONT = 30;

const loading = ref(true);
const failure = ref<"" | "unsupported" | "load">("");
const font = ref(props.fontSize);
const fraction = ref(0);
const tocOpen = ref(false);
const toc = shallowRef<FoliateTocItem[]>([]);
const activeLabel = ref("");
const host = ref<HTMLElement | null>(null);

let view: FoliateView | undefined;
let destroyed = false;

const hasToc = computed(() => toc.value.length > 0);

const bodyStyles = (): string => `
  @namespace epub "http://www.idpf.org/2007/ops";
  html { color-scheme: only light; }
  body { font-size: ${font.value}px; }
  p, li, blockquote, dd {
    line-height: 1.6;
    text-align: start;
    widows: 2;
    hyphens: manual;
  }
  [align="left"] { text-align: left; }
  [align="right"] { text-align: right; }
  [align="center"] { text-align: center; }
  [align="justify"] { text-align: justify; }
  pre { white-space: pre-wrap !important; }
  img, svg { max-width: 100% !important; height: auto !important; }
  aside[epub|type~="endnote"], aside[epub|type~="footnote"],
  aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
`;

const applyStyles = () => view?.renderer?.setStyles?.(bodyStyles());

const flattenToc = (items: FoliateTocItem[], depth = 0): { label: string; href: string; depth: number }[] =>
  items.flatMap((item) => [
    { label: item.label, href: item.href, depth },
    ...flattenToc(item.subitems ?? [], depth + 1),
  ]);

const open = async () => {
  failure.value = "";
  loading.value = true;
  try {
    // The engine is only imported once a book is actually opened: it is a few hundred KB of
    // renderers nobody needs while the file tree is on screen.
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
    element.addEventListener("external-link", onExternalLink as unknown as EventListener);

    await element.open(file);
    if (destroyed) {
      element.close();
      return;
    }
    toc.value = (element.book?.toc ?? []) as FoliateTocItem[];
    await element.init({ lastLocation: props.initialLocation || undefined, showTextStart: !props.initialLocation });
    loading.value = false;
    await nextTick();
    applyStyles();
  } catch (error) {
    if (destroyed) return;
    loading.value = false;
    failure.value = String((error as Error)?.name ?? "").includes("Unsupported")
      ? "unsupported"
      : "load";
  }
};

const onRelocate = (event: Event) => {
  const detail = (event as CustomEvent<FoliateLocation>).detail ?? {};
  fraction.value = detail.fraction ?? 0;
  activeLabel.value = detail.tocItem?.label ?? "";
  if (detail.cfi) emit("relocate", detail.cfi, fraction.value);
};

/**
 * A book may link to the web. foliate-js opens it with `window.open` only when the event is not
 * cancelled; cancelling keeps the reader inside the inspector instead of spawning a window.
 */
const onExternalLink = (event: Event) => {
  event.preventDefault();
};

const turn = (delta: number) => {
  if (!view || loading.value) return;
  if (delta < 0) void view.prev();
  else void view.next();
};

const goToLocation = (href: string) => {
  if (!view) return;
  tocOpen.value = false;
  void view.goTo(href);
};

const setFont = (next: number) => {
  const clamped = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(next)));
  if (clamped === font.value) return;
  font.value = clamped;
  applyStyles();
};

const onKeydown = (event: KeyboardEvent) => {
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

onMounted(() => {
  void open();
  globalThis.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  destroyed = true;
  globalThis.removeEventListener("keydown", onKeydown);
  view?.close();
  view = undefined;
  host.value?.replaceChildren();
});

watch(() => props.src, () => {
  view?.close();
  view = undefined;
  toc.value = [];
  fraction.value = 0;
  void open();
});
</script>

<template>
  <div class="epub-reader">
    <div v-if="!loading && !failure" class="reader-toolbar">
      <button type="button" :aria-label="tr('files.epubPreviousPage')" :title="tr('files.epubPreviousPage')" @click="turn(-1)"><ChevronLeft :size="15" /></button>
      <button type="button" :aria-label="tr('files.epubNextPage')" :title="tr('files.epubNextPage')" @click="turn(1)"><ChevronRight :size="15" /></button>
      <span class="epub-reader-label">{{ activeLabel || name }}</span>
      <span class="reader-spacer" />
      <button v-if="hasToc" type="button" :class="{ 'is-active': tocOpen }" :aria-expanded="tocOpen" :aria-label="tr('files.epubContents')" :title="tr('files.epubContents')" @click="tocOpen = !tocOpen"><List :size="15" /></button>
      <button type="button" :aria-label="tr('files.epubSmallerText')" :title="tr('files.epubSmallerText')" :disabled="font <= MIN_FONT" @click="setFont(font - 1)"><Minus :size="15" /></button>
      <span class="reader-zoomlabel">{{ font }}px</span>
      <button type="button" :aria-label="tr('files.epubLargerText')" :title="tr('files.epubLargerText')" :disabled="font >= MAX_FONT" @click="setFont(font + 1)"><Plus :size="15" /></button>
    </div>
    <!-- The host is never behind a `v-if`. foliate-js pages a book by measuring its own box, so a
         host that is absent while `loading` is true gets a detached `foliate-view`: the element
         never connects, the paginator never sees a size, `open()` never resolves, and the reader
         shows "loading" forever. The state below is an overlay for exactly that reason. -->
    <div class="epub-reader-body">
      <nav v-if="tocOpen && hasToc" class="epub-reader-toc" :aria-label="tr('files.epubContents')">
        <button
          v-for="item in flattenToc(toc)"
          :key="`${item.depth}-${item.href}-${item.label}`"
          type="button"
          :style="{ paddingInlineStart: `${10 + item.depth * 12}px` }"
          @click="goToLocation(item.href)"
        >{{ item.label }}</button>
      </nav>
      <div ref="host" class="epub-reader-host" />
    </div>
    <div v-if="!loading && !failure" class="epub-reader-progress" role="progressbar" :aria-valuenow="Math.round(fraction * 100)" aria-valuemin="0" aria-valuemax="100">
      <span :style="{ width: `${Math.round(fraction * 100)}%` }" />
    </div>
    <div v-if="loading" class="pdf-reader-state reader-overlay">
      <LoaderCircle v-spin :size="18" class="is-spinning" />
      <span>{{ tr("files.epubLoading") }}</span>
    </div>
    <div v-else-if="failure" class="pdf-reader-state pdf-reader-failure reader-overlay">
      <p>{{ failure === "unsupported" ? tr("files.epubUnsupported") : tr("files.epubLoadFailed") }}</p>
      <slot name="fallback" />
    </div>
  </div>
</template>
