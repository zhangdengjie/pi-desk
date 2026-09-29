<script setup lang="ts">
import { ui } from "../ui/classes";
import { computed, getCurrentInstance, ref } from "vue";
import { useAppStore } from "../stores/app";
import { useRevealedText } from "../composables/useRevealedText";
import type { WorkspaceFileLink } from "../utils/fileLinks";
import { slugifyHeading } from "../utils/markdown";
import { renderMarkdownDocument } from "../utils/markdownRenderer";
import { collectMarkdownOutline, type MarkdownOutlineEntry } from "../utils/markdownOutline";
import FileLinkContextMenu from "./FileLinkContextMenu.vue";

const props = defineProps<{
  text: string;
  streaming?: boolean;
  searchQuery?: string;
  searchActive?: boolean;
  /** Which hit *inside this block* is the current one, 0-based, in document order. Without it every
   *  hit in an active block is painted `is-active` - fine for the transcript, where the counter
   *  points at a message, but a single-document search (the file preview) has one global hit list
   *  and needs exactly one mark lit. */
  searchActiveIndex?: number;
  /** Workspace-relative path of the document being previewed. A relative Markdown link resolves
   *  against this file's own directory, exactly as it would on GitHub. Absent (chat messages,
   *  reasoning blocks) means "the reader is at the repository", so links stay root-relative. */
  basePath?: string;
}>();
// 本组件是多根（内容节点 + 右键菜单），Vue 不会自动透传 class/style，
// 必须自己绑到内容根节点上，否则调用方的布局类（如 .file-markdown-preview 的 overflow）会静默丢失。
defineOptions({ inheritAttrs: false });
const appStore = useAppStore();
// Parsing is cheap and one-off for a block that has finished arriving: a 119k-char
// document costs 12-15ms, 358k costs 34ms, and a full 1MiB of ASCII costs 131ms
// (markdown-it, measured with the app's own options). A *streaming* block is the
// opposite: `useRevealedText` reveals it a frame at a time and every frame re-parses
// what has come so far, so the ceiling there protects the frame budget, not correctness.
// One number for both cases silently turned any large file into a wall of raw text - a
// 119,423-char AGENTS.md previewed as one `<pre>` with an empty outline.
const STREAMING_MARKDOWN_CHARS = 100_000;
// Sized to the ceiling the Go side hands out: `maxFileBytes = 1 << 20`
// (internal/repository/repository.go:33) truncates every file preview at 1MiB, so a
// settled block can never legitimately exceed this and the file preview always renders.
const SETTLED_MARKDOWN_CHARS = 1_100_000;
const workspacePath = computed(() => appStore.activeThread?.workspacePath || "");
const linkBaseDir = computed(() => {
  const path = (props.basePath ?? "").replaceAll("\\", "/");
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
});
const contextMenu = ref<{ file: WorkspaceFileLink; x: number; y: number }>();
// Headings get an id so the outline and `#anchor` links have something to aim at. The prefix makes
// the id unique per rendered document: a transcript shows dozens of MarkdownBody instances at once,
// and two "## Setup" headings in one window would otherwise be an id collision the browser resolves
// by picking whichever comes first in the DOM - usually not the one the reader was looking at.
const instanceUid = `md${getCurrentInstance()?.uid ?? 0}`;
const slugCounts = new Map<string, number>();

// While the source is still growing (an answer streaming, a reasoning block live)
// the text is revealed a frame at a time. The store has the whole string from the
// first delta, so a raw render lands each provider chunk as a block - which is what
// reads as typing in clauses with stalls between them.
const shownText = useRevealedText(() => props.text, () => props.streaming === true);
const renderMarkdown = computed(() => shownText.value.length
  <= (props.streaming === true ? STREAMING_MARKDOWN_CHARS : SETTLED_MARKDOWN_CHARS));

function highlightRenderedHtml(html: string, query: string, active: boolean, activeIndex: number | null = null): string {
  const needle = query.trim();
  if (!needle || typeof document === "undefined") return html;
  let ordinal = -1;

  const template = document.createElement("template");
  template.innerHTML = html;
  const lowerNeedle = needle.toLocaleLowerCase();
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node instanceof Text && node.nodeValue?.toLocaleLowerCase().includes(lowerNeedle)) textNodes.push(node);
  }

  // The transcript counts occurrences in the *markdown source*, and source can hold more of them
  // than the rendered body does (a link's URL, an image alt, escaped markup). An ordinal past the
  // last mark used to light nothing at all - and the caller, finding no lit node, fell back to
  // centring the whole row, which measured -930px above the viewport on a tall merged turn
  // (`.pi/bin/hitprobe/search-scroll.html`). Clamping keeps exactly one mark lit, so "which one is
  // current" always has a box to scroll to. Callers that count from the DOM (the file preview)
  // never hit the clamp.
  let target = activeIndex;
  if (active && target !== null) {
    let total = 0;
    for (const node of textNodes) {
      const lowerText = node.nodeValue ?? "";
      let from = 0;
      let at = lowerText.toLocaleLowerCase().indexOf(lowerNeedle, from);
      while (at >= 0) { total += 1; from = at + needle.length; at = lowerText.toLocaleLowerCase().indexOf(lowerNeedle, from); }
    }
    if (total > 0) target = Math.min(target, total - 1);
  }

  for (const node of textNodes) {
    const text = node.nodeValue ?? "";
    const lowerText = text.toLocaleLowerCase();
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let matchIndex = lowerText.indexOf(lowerNeedle, cursor);
    while (matchIndex >= 0) {
      if (matchIndex > cursor) fragment.append(document.createTextNode(text.slice(cursor, matchIndex)));
      const mark = document.createElement("mark");
      ordinal += 1;
      const current = active && (target === null || ordinal === target);
      mark.className = `markdown-search-hit${current ? " is-active" : ""}`;
      mark.textContent = text.slice(matchIndex, matchIndex + needle.length);
      fragment.append(mark);
      cursor = matchIndex + needle.length;
      matchIndex = lowerText.indexOf(lowerNeedle, cursor);
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    node.parentNode?.replaceChild(fragment, node);
  }

  return template.innerHTML;
}

const rendered = computed(() => {
  if (!renderMarkdown.value) return "";
  const env = {
    workspacePath: workspacePath.value,
    baseDir: linkBaseDir.value,
    // Reset per pass: slugs are deduplicated by occurrence, and re-rendering the same document must
    // produce the same ids, otherwise an open outline would point at headings that no longer exist.
    slugCounts,
  };
  // A settled block is the one a virtualized scroll unmounts and remounts, so it is the one worth a
  // lookup; a streaming block changes every frame and must not enter the cache at all.
  const html = renderMarkdownDocument(shownText.value, env, instanceUid, props.streaming !== true);
  return highlightRenderedHtml(html, props.searchQuery ?? "", props.searchActive ?? false,
    props.searchActiveIndex ?? null);
});

const bodyElement = ref<HTMLElement>();

function anchorSelector(anchor: string): string {
  return anchor.replace(/["\\\s]/g, "");
}

/** Find a heading inside *this* document only - never `document.getElementById`, which would happily
 *  answer with a heading from a different message or a different preview tab. */
function findAnchorTarget(anchor: string): HTMLElement | undefined {
  const root = bodyElement.value;
  let needle = anchor.replace(/^#/, "").trim();
  try {
    needle = decodeURIComponent(needle);
  } catch {
    // A malformed escape is not a crash: fall back to the literal text the author wrote.
  }
  if (!root || !needle) return undefined;
  return root.querySelector<HTMLElement>(`[id="${anchorSelector(`${instanceUid}-${slugifyHeading(needle)}`)}"]`)
    ?? root.querySelector<HTMLElement>(`[id="${anchorSelector(needle)}"]`)
    ?? undefined;
}

/**
 * The headings of *this* rendered document, for a host that wants to list them.
 *
 * Only the component can answer reliably: the ids carry its own instance prefix, so an outline built
 * anywhere else would either miss the prefix or name a heading belonging to a different document that
 * happens to share the slug.
 */
function outline(): MarkdownOutlineEntry[] {
  const root = bodyElement.value;
  // No scroller passed: a host that scrolls the heading itself (the transcript) does not need an
  // offset, and the pane that does pass its own element to `collectMarkdownOutline` directly.
  return root ? collectMarkdownOutline(root) : [];
}

function scrollToAnchor(anchor: string): boolean {
  const target = findAnchorTarget(anchor);
  if (!target) return false;
  // Guarded the way ConversationPane and ComposerBar guard it: jsdom has no scrollIntoView at all,
  // and an unwrapped call would throw out of a click handler that is otherwise working.
  if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
  return true;
}
// The preview panel needs this because a cross-file link opens a tab whose MarkdownBody has not
// rendered yet; the ids are per-instance, so only the component itself can resolve one.
defineExpose({ scrollToAnchor, outline });

function fileLinkFromEvent(event: MouseEvent): WorkspaceFileLink | undefined {
  const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a.markdown-file-link") : null;
  const relativePath = target?.dataset.filePath;
  const absolutePath = target?.dataset.fileAbsolute;
  if (!target || !relativePath || !absolutePath) return undefined;
  const line = Number(target.dataset.fileLine);
  return {
    relativePath,
    absolutePath,
    name: target.dataset.fileName || relativePath.split("/").pop() || relativePath,
    line: Number.isFinite(line) && line > 0 ? line : undefined,
    anchor: target.dataset.fileAnchor || undefined,
  };
}

function openPreview(event: MouseEvent) {
  const file = fileLinkFromEvent(event);
  if (file) {
    event.preventDefault();
    contextMenu.value = undefined;
    void appStore.openRepositoryFilePreview(file.relativePath, file.line, true, file.anchor);
    return;
  }
  // A `#heading` link keeps its href so it is copyable, but letting the webview follow it would put
  // the fragment in the app's own URL. Scroll inside the preview pane instead, and swallow the
  // navigation even when the target does not exist - a dead anchor must not reload the shell.
  const anchor = event.target instanceof Element
    ? event.target.closest<HTMLAnchorElement>("a[href]")
    : null;
  const href = anchor?.getAttribute("href") ?? "";
  if (anchor && href.length > 1 && href.startsWith("#")) {
    event.preventDefault();
    contextMenu.value = undefined;
    scrollToAnchor(href.slice(1));
    return;
  }
  const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a.markdown-web-link") : null;
  const webHref = target?.getAttribute("href");
  if (!target || !webHref) return;
  event.preventDefault();
  appStore.openBrowserTab(webHref);
}

function openContextMenu(event: MouseEvent) {
  const file = fileLinkFromEvent(event);
  if (!file) return;
  event.preventDefault();
  contextMenu.value = { file, x: event.clientX, y: event.clientY };
}
</script>

<template>
  <div
    v-if="renderMarkdown"
    ref="bodyElement"
    v-bind="$attrs"
    class="markdown-body"
    :class="[ui.root, { streaming }]"
    :data-markdown-uid="instanceUid"
    v-html="rendered"
    @click="openPreview"
    @contextmenu="openContextMenu"
  />
  <pre v-else v-bind="$attrs" class="oversized-message" :class="ui.code">{{ text }}</pre>
  <FileLinkContextMenu
    v-if="contextMenu && workspacePath"
    :file="contextMenu.file"
    :workspace-path="workspacePath"
    :x="contextMenu.x"
    :y="contextMenu.y"
    @close="contextMenu = undefined"
  />
</template>
