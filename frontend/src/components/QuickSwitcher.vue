<script setup lang="ts">
/**
 * ⌘K - jump to any session by title, workspace or path.
 *
 * The sidebar can only show a screenful per workspace, and with a dozen workspaces the thing you
 * want is usually "the session where I fixed the drag jitter", not a folder you have to expand
 * first. Every harness this one is measured against (Cursor, Claude's desktop app, VS Code) puts
 * that behind ⌘K, so the gesture is already in the reader's hands.
 *
 * Deliberately not a command palette yet: it switches sessions and nothing else. A palette that
 * also runs actions needs an action registry and a result-type contract, and half of one is worse
 * than this.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Search } from "lucide-vue-next";
import { tr } from "../i18n";
import { catalogService } from "../services/catalog";
import { useAppStore } from "../stores/app";
import { rankFuzzy } from "../utils/fuzzySearch";
import { relativeTimeText } from "../utils/relativeTime";
import { threadTitleText } from "../utils/threadLabel";
import type { ThreadSummary } from "../stores/app";

const appStore = useAppStore();
const open = ref(false);
const query = ref("");
const activeIndex = ref(0);
const input = ref<HTMLInputElement>();
const list = ref<HTMLElement>();
const now = ref(Date.now());

const candidates = computed(() => appStore.threads.filter((thread) => !thread.archived));

// Cross-session prose search. Title matching is instant because the desktop state already holds
// every title; this part reads transcripts off disk (386ms for 417MB of history on the machine this
// was measured on), so it is debounced and never blocks the first results from appearing.
const CONTENT_QUERY_MIN = 2;
const CONTENT_DEBOUNCE_MS = 300;
const contentHits = ref<Array<{ thread: ThreadSummary; snippet: string; matches: number }>>([]);
const contentLoading = ref(false);
const contentTruncated = ref(false);
let contentTimer: ReturnType<typeof setTimeout> | undefined;
let contentSequence = 0;

function label(thread: ThreadSummary): string {
  return threadTitleText(thread.title) || tr("sidebar.untitled");
}

const results = computed(() => {
  const needle = query.value.trim();
  if (!needle) {
    return [...candidates.value]
      .sort((left, right) => Date.parse(right.modifiedAt || right.createdAt || "") - Date.parse(left.modifiedAt || left.createdAt || ""))
      .slice(0, 9);
  }
  return rankFuzzy(candidates.value, needle, (thread) => [
    label(thread),
    thread.workspace,
    thread.workspacePath,
    thread.firstMessage ?? "",
  ]).slice(0, 12);
});

function clearContentSearch() {
  if (contentTimer) clearTimeout(contentTimer);
  contentTimer = undefined;
  contentSequence += 1;
  contentHits.value = [];
  contentLoading.value = false;
  contentTruncated.value = false;
}

async function runContentSearch(needle: string) {
  const sequence = ++contentSequence;
  try {
    const result = await catalogService.searchAllSessions(needle, 20);
    if (sequence !== contentSequence || !open.value) return;
    const byPath = new Map<string, ThreadSummary>();
    for (const thread of appStore.threads) {
      if (thread.sessionFile) byPath.set(thread.sessionFile, thread);
    }
    const titleMatched = new Set(results.value.map((thread) => thread.id));
    const hits: Array<{ thread: ThreadSummary; snippet: string; matches: number }> = [];
    for (const hit of result.hits ?? []) {
      const thread = byPath.get(hit.path);
      // A hit whose session has no thread in the desktop state is an orphan file; there is nowhere
      // to jump to, so it is dropped rather than rendered as a dead row.
      if (!thread || titleMatched.has(thread.id)) continue;
      hits.push({ thread, snippet: hit.snippet, matches: hit.matches });
    }
    contentHits.value = hits;
    contentTruncated.value = result.truncated === true;
  } catch {
    // A failed content search must not take the palette down: the title results still work.
    if (sequence === contentSequence) contentHits.value = [];
  } finally {
    if (sequence === contentSequence) contentLoading.value = false;
  }
}

function scheduleContentSearch() {
  if (contentTimer) clearTimeout(contentTimer);
  const needle = query.value.trim();
  if (needle.length < CONTENT_QUERY_MIN) {
    clearContentSearch();
    return;
  }
  contentLoading.value = true;
  contentTimer = setTimeout(() => void runContentSearch(needle), CONTENT_DEBOUNCE_MS);
}

function openPalette() {
  if (open.value) return close();
  // Another dialog owns the keyboard: stacking a second modal over it is how Escape ends up
  // closing the wrong one. Settings is checked through the store because that dialog carries no
  // `role="dialog"` (the rest are mounted on a flag and would also be caught by the DOM check).
  if (appStore.settingsOpen || appStore.newTaskOpen || appStore.aboutOpen || appStore.orphanSessionsOpen
    || appStore.remoteReconnectOpen || appStore.branchPanelOpen || appStore.deleteDialogOpen
    || appStore.exportDialogOpen || appStore.extensionDialogVisible) return;
  if (document.querySelector("[role='dialog']")) return;
  open.value = true;
  query.value = "";
  activeIndex.value = 0;
  clearContentSearch();
  now.value = Date.now();
  void nextTick(() => input.value?.focus());
}

function close() {
  open.value = false;
  query.value = "";
  clearContentSearch();
}

// One flat list so the arrow keys walk title hits and content hits without a special case; the two
// groups are only a visual distinction.
const rows = computed(() => [
  ...results.value.map((thread) => ({ key: `thread:${thread.id}`, kind: "thread" as const, thread })),
  ...contentHits.value.map((hit) => ({ key: `content:${hit.thread.id}`, kind: "content" as const, thread: hit.thread, snippet: hit.snippet, matches: hit.matches })),
]);

function move(delta: number) {
  const total = rows.value.length;
  if (!total) return;
  activeIndex.value = (activeIndex.value + delta + total) % total;
}

async function choose(index = activeIndex.value) {
  const thread = rows.value[index]?.thread;
  if (!thread) return;
  close();
  appStore.selectThread(thread.id);
}

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k" && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    openPalette();
    return;
  }
  if (!open.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
    event.preventDefault();
    move(1);
    return;
  }
  if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
    event.preventDefault();
    move(-1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    void choose();
  }
}

watch(query, () => {
  activeIndex.value = 0;
  scheduleContentSearch();
});

watch(activeIndex, async () => {
  await nextTick();
  const row = list.value?.querySelector<HTMLElement>('[aria-selected="true"]');
  row?.scrollIntoView({ block: "nearest" });
});

// One listener, on `document`, and nothing on the input: the palette's keys are handled in the
// bubble phase after focus lands in the search box, so binding the same handler to the input too
// ran every arrow key twice (one press = two rows).
onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  if (contentTimer) clearTimeout(contentTimer);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="quick-switcher-scrim" @pointerdown.self="close">
      <div class="quick-switcher" role="dialog" aria-modal="true" :aria-label="tr('quickSwitch.title')">
        <div class="quick-switcher-search">
          <Search :size="15" aria-hidden="true" />
          <input
            ref="input"
            v-model="query"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :placeholder="tr('quickSwitch.placeholder')"
            :aria-label="tr('quickSwitch.placeholder')"
          />
        </div>
        <ul v-if="rows.length" ref="list" class="quick-switcher-list" role="listbox" :aria-label="tr('quickSwitch.title')">
          <li
            v-for="(row, index) in rows"
            :key="row.key"
            class="quick-switcher-row"
            :class="{ 'is-active': index === activeIndex, 'is-current': row.thread.id === appStore.activeThreadId, 'is-content': row.kind === 'content' }"
            role="option"
            :aria-selected="index === activeIndex"
            @pointermove="activeIndex = index"
            @click="void choose(index)"
          >
            <span class="quick-switcher-title">{{ label(row.thread) }}</span>
            <span v-if="row.kind === 'content'" class="quick-switcher-snippet">{{ row.snippet }}</span>
            <span class="quick-switcher-meta">
              <span v-if="row.kind === 'content'" class="quick-switcher-badge">{{ tr("quickSwitch.inContent") }}</span>
              <span class="quick-switcher-workspace">{{ row.thread.workspace }}</span>
              <span v-if="row.thread.status === 'running'" class="quick-switcher-running">{{ tr("quickSwitch.running") }}</span>
              <span v-else-if="row.thread.unread" class="quick-switcher-unread">{{ tr("quickSwitch.unread") }}</span>
              <time :datetime="row.thread.modifiedAt || row.thread.createdAt">{{ relativeTimeText(row.thread.modifiedAt || row.thread.createdAt, now) }}</time>
            </span>
          </li>
        </ul>
        <p v-else-if="contentLoading" class="quick-switcher-empty" role="status">{{ tr("quickSwitch.searching") }}</p>
        <p v-else class="quick-switcher-empty">{{ contentTruncated ? tr("quickSwitch.truncated") : tr("quickSwitch.empty") }}</p>
        <footer class="quick-switcher-hint">
          <span><kbd>↑</kbd><kbd>↓</kbd>{{ tr("quickSwitch.move") }}</span>
          <span><kbd>↵</kbd>{{ tr("quickSwitch.open") }}</span>
          <span><kbd>esc</kbd>{{ tr("quickSwitch.close") }}</span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>