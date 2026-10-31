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
  now.value = Date.now();
  void nextTick(() => input.value?.focus());
}

function close() {
  open.value = false;
  query.value = "";
}

function move(delta: number) {
  const total = results.value.length;
  if (!total) return;
  activeIndex.value = (activeIndex.value + delta + total) % total;
}

async function choose(index = activeIndex.value) {
  const thread = results.value[index];
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
});

watch(activeIndex, async () => {
  await nextTick();
  const row = list.value?.querySelector<HTMLElement>('[aria-selected="true"]');
  row?.scrollIntoView({ block: "nearest" });
});

onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
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
            @keydown="onKeydown"
          />
        </div>
        <ul v-if="results.length" ref="list" class="quick-switcher-list" role="listbox" :aria-label="tr('quickSwitch.title')">
          <li
            v-for="(thread, index) in results"
            :key="thread.id"
            class="quick-switcher-row"
            :class="{ 'is-active': index === activeIndex, 'is-current': thread.id === appStore.activeThreadId }"
            role="option"
            :aria-selected="index === activeIndex"
            @pointermove="activeIndex = index"
            @click="void choose(index)"
          >
            <span class="quick-switcher-title">{{ label(thread) }}</span>
            <span class="quick-switcher-meta">
              <span class="quick-switcher-workspace">{{ thread.workspace }}</span>
              <span v-if="thread.status === 'running'" class="quick-switcher-running">{{ tr("quickSwitch.running") }}</span>
              <span v-else-if="thread.unread" class="quick-switcher-unread">{{ tr("quickSwitch.unread") }}</span>
              <time :datetime="thread.modifiedAt || thread.createdAt">{{ relativeTimeText(thread.modifiedAt || thread.createdAt, now) }}</time>
            </span>
          </li>
        </ul>
        <p v-else class="quick-switcher-empty">{{ tr("quickSwitch.empty") }}</p>
        <footer class="quick-switcher-hint">
          <span><kbd>↑</kbd><kbd>↓</kbd>{{ tr("quickSwitch.move") }}</span>
          <span><kbd>↵</kbd>{{ tr("quickSwitch.open") }}</span>
          <span><kbd>esc</kbd>{{ tr("quickSwitch.close") }}</span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>