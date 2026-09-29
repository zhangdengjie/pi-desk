<script setup lang="ts">
import { ui } from "../ui/classes";
import MarkdownIt from "markdown-it";
import { computed, getCurrentInstance, ref } from "vue";
import { useAppStore } from "../stores/app";
import { useRevealedText } from "../composables/useRevealedText";
import { resolveWorkspaceFileLink, type WorkspaceFileLink } from "../utils/fileLinks";
import { normalizeMarkdownBreakTags, slugifyHeading, uniqueHeadingSlug } from "../utils/markdown";
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
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false });
const defaultValidateLink = markdown.validateLink.bind(markdown);
const originalLinkOpen = markdown.renderer.rules.link_open;

markdown.renderer.rules.heading_open = (tokens, index, options, _env, self) => {
  const inline = tokens[index + 1];
  tokens[index].attrSet("id", `${instanceUid}-${uniqueHeadingSlug(slugCounts, inline?.type === "inline" ? inline.content : "")}`);
  return self.renderToken(tokens, index, options);
};

markdown.validateLink = (url) => /^file:/i.test(url) || defaultValidateLink(url);
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const rawHref = tokens[index].attrGet("href");
  const href = typeof rawHref === "string" ? rawHref : String(rawHref ?? "");
  const linkEnvironment = (environment ?? {}) as { workspacePath?: string; baseDir?: string };
  const file = resolveWorkspaceFileLink(href, String(linkEnvironment.workspacePath ?? ""), String(linkEnvironment.baseDir ?? ""));
  if (file) {
    tokens[index].attrSet("href", "#");
    tokens[index].attrSet("class", "markdown-file-link");
    tokens[index].attrSet("title", file.absolutePath);
    tokens[index].attrSet("data-file-path", file.relativePath);
    tokens[index].attrSet("data-file-absolute", file.absolutePath);
    tokens[index].attrSet("data-file-name", file.name);
    if (file.line) tokens[index].attrSet("data-file-line", String(file.line));
    if (file.anchor) tokens[index].attrSet("data-file-anchor", file.anchor);
  } else if (/^(https?:)\/\//i.test(href)) {
    // Web links route to the managed browser panel; the click handler below
    // prevents default and falls back to the system browser on failure.
    tokens[index].attrSet("class", "markdown-web-link");
  } else if (/^(mailto:|tel:)/i.test(href)) {
    tokens[index].attrSet("target", "_blank");
    tokens[index].attrSet("rel", "noopener noreferrer");
  } else if (!href.startsWith("#")) {
    tokens[index].attrSet("href", "#");
  }
  return originalLinkOpen
    ? originalLinkOpen(tokens, index, options, environment, renderer)
    : renderer.renderToken(tokens, index, options);
};

// markdown-it emits bare <table>. A table can only scroll sideways if some box
// around it owns the overflow, and a <table> cannot be that box without losing
// its own table layout (see .markdown-table-scroll in layout.css). So every
// rendered table gets a scroll wrapper here, in the one place markdown becomes
// HTML, which also keeps streamed reasoning and file previews on the same shape.
// The column count travels with the table because the cell floor in layout.css has
// to divide the pane by it: an absolute floor on every prose cell summed past the
// reading axis on wide tables (8 columns × 200px in a 880px pane), so the table
// overflowed and the label columns were left with one glyph per line.
function tableColumnCount(tokens: CellTokens, index: number): number {
  let columns = 0;
  for (let i = index + 1; i < tokens.length && tokens[i].type !== "tr_close"; i++) {
    if (tokens[i].type === "th_open" || tokens[i].type === "td_open") columns++;
  }
  return Math.max(columns, 1);
}

markdown.renderer.rules.table_open = (tokens, index, options, _env, self) =>
  `<div class="markdown-table-scroll" style="--markdown-table-cols:${tableColumnCount(tokens, index)}">${self.renderToken(tokens, index, options)}`;
markdown.renderer.rules.table_close = (tokens, index, options, _env, self) =>
  `${self.renderToken(tokens, index, options)}</div>`;

// Measured in both engines (WebKit = the one this app renders with, plus Blink as
// control): a bare text cell ignores max-width on <th>/<td> — WebKit laid the column
// out at 490px for a 340px cap. A block child inside the cell fixes it (340px in both
// engines). So every cell gets one wrapper and the ceiling lives on that wrapper.
// A column floor is only useful on cells that actually hold prose: applied to "Go" or
// "1.26.1" it inflates a two-column value table to hundreds of pixels of dead space.
// CSS cannot express "floor, but never above the content" — min(340px, max-content)
// computes to 0px in both engines (re-measured 2026-09-25: min(max-content, 100cqi/cols)
// leaves a label column at 41px), so the renderer decides from the cell's own text.
const WIDE_CELL_MIN_CHARS = 24;
// Short labels ("持仓", "科大讯飞", "❌ 第三次点名") have no soft-wrap opportunity either,
// and auto table layout squeezes them to one glyph per line as soon as the prose
// columns need the room. Under this many codepoints the cell is cheap enough to keep
// on a single line unconditionally, so it never has to be floored by a percentage.
const NOWRAP_MAX_CHARS = 8;

type CellTokens = Parameters<NonNullable<typeof markdown.renderer.rules.td_open>>[0];

function cellFitClass(tokens: CellTokens, index: number): string {
  const inline = tokens[index + 1];
  if (!inline || inline.type !== "inline") return "";
  const chars = Array.from(inline.content ?? "").length;
  if (chars >= WIDE_CELL_MIN_CHARS) return " is-wide";
  return chars <= NOWRAP_MAX_CHARS ? " is-nowrap" : "";
}

markdown.renderer.rules.th_open = (tokens, index, options, _env, self) =>
  `${self.renderToken(tokens, index, options)}<div class="markdown-cell${cellFitClass(tokens, index)}">`;
markdown.renderer.rules.td_open = (tokens, index, options, _env, self) =>
  `${self.renderToken(tokens, index, options)}<div class="markdown-cell${cellFitClass(tokens, index)}">`;
markdown.renderer.rules.th_close = (tokens, index, options, _env, self) =>
  `</div>${self.renderToken(tokens, index, options)}`;
markdown.renderer.rules.td_close = (tokens, index, options, _env, self) =>
  `</div>${self.renderToken(tokens, index, options)}`;

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
  // Reset per pass: slugs are deduplicated by occurrence, and re-rendering the same document must
  // produce the same ids, otherwise an open outline would point at headings that no longer exist.
  slugCounts.clear();
  const html = markdown.render(normalizeMarkdownBreakTags(shownText.value), {
    workspacePath: workspacePath.value,
    baseDir: linkBaseDir.value,
  });
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
