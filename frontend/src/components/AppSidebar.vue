<script setup lang="ts">
import { ui } from "../ui/classes";
import {
  Copy,
  CalendarClock,
  Download,
  FileSearch,
  Folder,
  FolderOpen,
  GitBranch,
  MessageCirclePlus,
  MoreHorizontal,
  PanelLeftOpen,
  Pencil,
  Plug,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Play,
  ChevronDown,
  ChevronRight,
  Square,
  SquarePen,
  Trash2,
  Unplug,
  X,
  Zap,
} from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import RuntimeBadge from "./RuntimeBadge.vue";
import RemoveWorkspaceDialog from "./RemoveWorkspaceDialog.vue";
import ThreadRowMarks from "./ThreadRowMarks.vue";
import { useAppStore, type ThreadSummary } from "../stores/app";
import { tr } from "../i18n";
import { threadTooltip } from "../utils/threadLabel";
import { PANEL_SETTLE_MS } from "../utils/paneMotion";

const appStore = useAppStore();
const searchInput = ref<HTMLInputElement>();

// Pane motion · the left rail (任务). `workbench.css` interpolates `.app-shell`'s first grid track
// from --sidebar-width to --sidebar-collapsed-width over --motion-panel, and every block below is
// `v-if`-ed off that same flag. Bound straight to `appStore.sidebarCollapsed` they would vanish on
// frame 0 and leave an empty column to slide shut, so `collapsed` lags the store on the way in and
// leads it on the way out: the content is clipped by `.sidebar { overflow: hidden }` for exactly the
// width it still has, and on expand it is revealed by the widening track instead of popping back.
// Anything that is behaviour rather than presence (line 150's expand-then-search, the row menus)
// keeps reading the store flag.
const collapsed = ref(appStore.sidebarCollapsed);
let collapseSettleTimer: number | undefined;
watch(() => appStore.sidebarCollapsed, (value) => {
  if (collapseSettleTimer !== undefined) {
    window.clearTimeout(collapseSettleTimer);
    collapseSettleTimer = undefined;
  }
  if (!value) {
    collapsed.value = false;
    return;
  }
  collapseSettleTimer = window.setTimeout(() => {
    collapseSettleTimer = undefined;
    if (appStore.sidebarCollapsed) collapsed.value = true;
  }, PANEL_SETTLE_MS);
});
const collapsedWorkspaceIDs = ref<Record<string, boolean>>({});
const taskMenu = ref({ open: false, threadId: "", x: 0, y: 0 });
const workspaceMenu = ref({ open: false, workspaceID: "", x: 0, y: 0 });
const activeSessionsCollapsed = ref(false);
const workspaceActionID = ref("");
const workspaceActionError = ref("");
const workspaceRenameID = ref("");
const workspaceRenameValue = ref("");
const workspaceRenameInput = ref<HTMLInputElement>();
const workspaceRemovalID = ref("");
const taskRenameOpen = ref(false);
const taskRenameID = ref("");
const taskRenameValue = ref("");
const taskRenameInput = ref<HTMLInputElement>();
const relativeTimeNow = ref(Date.now());
let relativeTimeTimer: ReturnType<typeof setInterval> | undefined;
const taskMenuThread = computed(() => appStore.threads.find((thread) => thread.id === taskMenu.value.threadId));
/**
 * A thread's workspace. Same rule as `workspaceGroups` below and the same one the store writes with:
 * `workspaceId` when the thread was created from a registered workspace, otherwise the normalised
 * path (SSH workspaces have no local path at all, so they only ever match by id).
 */
function workspaceForThread(thread: ThreadSummary) {
  return appStore.workspaces.find((workspace) => thread.workspaceId
    ? workspace.id === thread.workspaceId
    : comparablePath(workspace.path) === comparablePath(thread.workspacePath));
}
const taskMenuWorkspace = computed(() => {
  const thread = taskMenuThread.value;
  return thread ? workspaceForThread(thread) : undefined;
});
const workspaceMenuItem = computed(() => appStore.workspaces.find((workspace) => workspace.id === workspaceMenu.value.workspaceID));
const workspaceRemovalItem = computed(() => appStore.workspaces.find((workspace) => workspace.id === workspaceRemovalID.value));

function relativeTime(value?: string): string {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.max(0, Math.floor((relativeTimeNow.value - timestamp) / 60_000));
  if (minutes < 1) return tr("sidebar.justNow");
  if (minutes < 60) return tr("sidebar.relativeMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tr("sidebar.relativeHours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return tr("sidebar.relativeDays", { count: days });
  const months = Math.floor(days / 30);
  if (months < 12) return tr("sidebar.relativeMonths", { count: months });
  return tr("sidebar.relativeYears", { count: Math.floor(months / 12) });
}

function comparablePath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "").replaceAll("\\", "/");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

const workspaceGroups = computed(() => appStore.workspaces.map((workspace) => {
  const threads = appStore.filteredThreads.filter((thread) => workspace.kind === "ssh"
    ? thread.workspaceId === workspace.id
    : comparablePath(thread.workspacePath) === comparablePath(workspace.path));
  return { workspace, threads, threadCount: threads.length };
}).filter((group) => !appStore.searchQuery.trim() || group.threadCount > 0));

/**
 * The cross-project list. `workspaceGroups` is the right shape for browsing a project, and the wrong
 * shape for "go back to the session I was just running": with a dozen workspaces, only one or two of
 * which hold a live Pi process, finding them means expanding groups one by one. So anything whose Pi
 * process is still up, or that has output you have not read, is repeated here - newest activity first,
 * project named on the row. Hidden while a search is running: two filtered lists would disagree.
 *
 * `attention` is deliberately NOT a membership test. It survives a restart (`app.ts` restores a thread
 * that was mid-run as `attention` + "Previous Pi run was interrupted", with `started: false`), so on a
 * seeded profile it swamped the list: measured in the sandbox at 11:21, 5 of 7 rows were stale
 * attention flags and only 2 sessions were actually alive. The amber dot in the group list still shows
 * it, where it reads as "this one errored" instead of "this one is active".
 */
const activeSessionThreads = computed(() => appStore.filteredThreads.filter((thread) => thread.started || thread.unread));

function activeSessionLabel(thread: ThreadSummary): string {
  const workspace = workspaceForThread(thread);
  return workspace?.name || thread.workspace || "";
}

/** The tooltip has to carry the project name too: in this list the group header is not above the row. */
function activeSessionTooltip(thread: ThreadSummary): string {
  const base = threadTooltip(thread);
  const workspace = activeSessionLabel(thread);
  if (!workspace) return base;
  return `${base}\n\n${tr("sidebar.inWorkspace", { workspace })}`;
}
const defaultExpandedWorkspaceID = computed(() => {
  const activeThread = appStore.activeThread;
  const activeWorkspace = activeThread && appStore.workspaces.find((workspace) => workspace.kind === "ssh"
    ? activeThread.workspaceId === workspace.id
    : comparablePath(activeThread.workspacePath) === comparablePath(workspace.path));
  return activeWorkspace?.id || workspaceGroups.value.find((group) => group.threadCount > 0)?.workspace.id || "";
});

watch(() => appStore.searchQuery, (query) => {
  if (query.trim()) void appStore.loadSessionSearchBodies();
  else appStore.cancelSessionSearch();
});

function isWorkspaceCollapsed(workspaceID: string): boolean {
  if (appStore.searchQuery.trim()) return false;
  return collapsedWorkspaceIDs.value[workspaceID] ?? workspaceID !== defaultExpandedWorkspaceID.value;
}

function toggleWorkspace(workspaceID: string) {
  collapsedWorkspaceIDs.value[workspaceID] = !isWorkspaceCollapsed(workspaceID);
}

async function toggleSearch() {
  if (!appStore.searchOpen && appStore.sidebarCollapsed) appStore.toggleSidebar();
  appStore.toggleSearch();
  if (appStore.searchOpen) {
    await nextTick();
    searchInput.value?.focus();
  }
}

function closeTaskMenu() {
  taskMenu.value.open = false;
}

async function beginTaskRename() {
  const thread = taskMenuThread.value;
  closeTaskMenu();
  if (!thread) return;
  taskRenameID.value = thread.id;
  taskRenameValue.value = thread.title;
  taskRenameOpen.value = true;
  await nextTick();
  taskRenameInput.value?.focus();
  taskRenameInput.value?.select();
}

function closeTaskRename() {
  taskRenameOpen.value = false;
  taskRenameID.value = "";
}

async function submitTaskRename() {
  const thread = appStore.threads.find((item) => item.id === taskRenameID.value);
  const name = taskRenameValue.value.trim();
  if (!thread || !name) return;
  if (appStore.activeThreadId !== thread.id) appStore.selectThread(thread.id);
  await appStore.renameActiveSession(name);
  closeTaskRename();
}

async function runTaskAction(action: "branch" | "clone" | "export" | "compact") {
  const thread = taskMenuThread.value;
  closeTaskMenu();
  if (!thread) return;
  if (appStore.activeThreadId !== thread.id) appStore.selectThread(thread.id);
  if (action === "branch") await appStore.openBranchPanel();
  else if (action === "clone") await appStore.cloneActiveSession();
  else if (action === "export") await appStore.exportActiveSession();
  else await appStore.compactActiveSession();
}

function closeWorkspaceMenu() {
  workspaceMenu.value.open = false;
}

async function openWorkspaceRename() {
  const workspace = workspaceMenuItem.value;
  closeWorkspaceMenu();
  if (!workspace || workspaceActionID.value) return;
  workspaceRenameID.value = workspace.id;
  workspaceRenameValue.value = workspace.name;
  await nextTick();
  workspaceRenameInput.value?.focus();
  workspaceRenameInput.value?.select();
}

function cancelWorkspaceRename() {
  workspaceRenameID.value = "";
  workspaceRenameValue.value = "";
}

async function submitWorkspaceRename() {
  const id = workspaceRenameID.value;
  const name = workspaceRenameValue.value.trim();
  cancelWorkspaceRename();
  if (!id || !name || workspaceActionID.value) return;
  const workspace = appStore.workspaces.find((item) => item.id === id);
  if (!workspace || workspace.name === name) return;
  workspaceActionID.value = id;
  workspaceActionError.value = "";
  try {
    await appStore.renameWorkspace(id, name);
  } catch (error) {
    workspaceActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    workspaceActionID.value = "";
  }
}

function openTaskMenu(event: MouseEvent, threadId: string) {
  const width = 210;
  const height = 300;
  taskMenu.value = {
    open: true,
    threadId,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
  };
}

async function openTaskWorkspace() {
  const workspace = taskMenuWorkspace.value;
  closeTaskMenu();
  if (!workspace) return;
  try {
    await appStore.openWorkspace(workspace.id);
  } catch (error) {
    workspaceActionError.value = error instanceof Error ? error.message : String(error);
  }
}

function openWorkspaceMenu(event: MouseEvent, workspaceID: string) {
  const width = 220;
  const height = 124;
  taskMenu.value.open = false;
  workspaceMenu.value = {
    open: true,
    workspaceID,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY + 8, window.innerHeight - height - 8)),
  };
}

async function runWorkspaceAction(action: "newTask" | "open" | "connect" | "disconnect") {
  const workspace = workspaceMenuItem.value;
  closeWorkspaceMenu();
  if (!workspace || workspaceActionID.value) return;
  workspaceActionID.value = workspace.id;
  workspaceActionError.value = "";
  try {
    if (action === "newTask") {
      if (workspace.kind === "ssh") await appStore.createRemoteTaskInWorkspace(workspace.id);
      else await appStore.createThread(workspace.path, workspace.trust);
      if (appStore.activeThreadId) appStore.startThreadInBackground(appStore.activeThreadId);
    } else if (action === "open") await appStore.openWorkspace(workspace.id);
    else if (action === "connect") await appStore.connectRemoteWorkspace(workspace.id);
    else await appStore.disconnectRemoteWorkspace(workspace.id);
  } catch (error) {
    workspaceActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    workspaceActionID.value = "";
  }
}

function openWorkspaceRemoval() {
  const workspace = workspaceMenuItem.value;
  closeWorkspaceMenu();
  if (!workspace || workspaceActionID.value) return;
  workspaceActionError.value = "";
  workspaceRemovalID.value = workspace.id;
}

function closeWorkspaceRemoval() {
  if (workspaceActionID.value) return;
  workspaceRemovalID.value = "";
  workspaceActionError.value = "";
}

async function confirmWorkspaceRemoval(deleteSessions: boolean) {
  const workspace = workspaceRemovalItem.value;
  if (!workspace || workspaceActionID.value) return;
  workspaceActionID.value = workspace.id;
  workspaceActionError.value = "";
  try {
    await appStore.removeWorkspace(workspace.id, deleteSessions);
    workspaceRemovalID.value = "";
  } catch (error) {
    workspaceActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    workspaceActionID.value = "";
  }
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    closeTaskMenu();
    closeWorkspaceMenu();
  }
}

function onDocumentClick() {
  closeTaskMenu();
  closeWorkspaceMenu();
}

onMounted(() => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeydown);
  relativeTimeTimer = setInterval(() => { relativeTimeNow.value = Date.now(); }, 60_000);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onDocumentKeydown);
  if (relativeTimeTimer) clearInterval(relativeTimeTimer);
  if (collapseSettleTimer !== undefined) window.clearTimeout(collapseSettleTimer);
});
</script>

<template>
  <aside class="sidebar col-start-1 row-start-2 flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--bg-sidebar)]" :class="ui.root" :aria-label="tr('sidebar.navigation')">
    <button
      v-if="collapsed"
      class="icon-button sidebar-expand-button mx-auto mt-2 inline-grid size-7 shrink-0 place-items-center rounded-md border border-transparent bg-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:bg-[var(--bg-active)] focus-visible:outline-2 focus-visible:outline-[var(--focus)]" :class="ui.iconButton"
      type="button"
      :title="tr('sidebar.expand')"
      :aria-label="tr('sidebar.expand')"
      @click="appStore.toggleSidebar"
    >
      <PanelLeftOpen :size="17" />
    </button>
    <nav v-else class="primary-nav grid gap-0.5 border-b border-[var(--border)] px-2.5 py-1.5" :aria-label="tr('sidebar.primaryNav')">
      <button v-if="!collapsed" class="new-task-button flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-md border border-transparent bg-transparent px-2.5 text-[var(--font-size-body)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:bg-[var(--bg-active)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--focus)]" type="button" :title="tr('sidebar.newTask')" :aria-label="tr('sidebar.newTask')" @click="appStore.openNewTask">
        <MessageCirclePlus :size="20" :stroke-width="1.7" />
        <span>{{ tr("sidebar.newTask") }}</span>
      </button>
      <button
        v-if="!collapsed"
        class="flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-md border border-transparent bg-transparent px-2.5 text-[var(--font-size-body)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:bg-[var(--bg-active)] aria-pressed:bg-[var(--bg-active)] aria-pressed:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
        type="button"
        :title="tr('sidebar.scheduledTasks')"
        :aria-label="tr('sidebar.scheduledTasks')"
        :aria-pressed="appStore.activePage === 'scheduledTasks'"
        @click="appStore.openScheduledTasks"
      >
        <CalendarClock :size="20" :stroke-width="1.7" />
        <span>{{ tr("sidebar.scheduledTasks") }}</span>
      </button>
      <div class="primary-nav-row flex min-w-0 items-center">
        <button v-if="!collapsed" class="primary-nav-search flex h-8 w-full min-w-0 items-center gap-2 whitespace-nowrap rounded-md border border-transparent bg-transparent px-2.5 text-[var(--font-size-body)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:bg-[var(--bg-active)] focus-visible:outline-2 focus-visible:outline-[var(--focus)]" type="button" :title="tr('sidebar.openSearch')" :aria-label="tr('sidebar.openSearch')" :aria-pressed="appStore.searchOpen" @click="toggleSearch">
          <Search :size="20" :stroke-width="1.7" />
          <span>{{ tr("sidebar.search") }}</span>
        </button>
      </div>
      <button v-if="!collapsed" class="flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-md border border-transparent bg-transparent px-2.5 text-[var(--font-size-body)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:bg-[var(--bg-active)] aria-pressed:bg-[var(--bg-active)] aria-pressed:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--focus)]" type="button" :title="tr('sidebar.review')" :aria-label="tr('sidebar.review')" :aria-pressed="appStore.inspectorOpen && appStore.inspectorTab === 'changes'" @click="appStore.toggleInspector('changes')">
        <FileSearch :size="20" :stroke-width="1.7" />
        <span>{{ tr("sidebar.review") }}</span>
      </button>
    </nav>

    <div v-if="!collapsed && appStore.searchOpen" class="sidebar-search mx-3 mt-3 h-9 grid-cols-[18px_minmax(0,1fr)_28px] items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-workspace)] px-2 text-[var(--text-muted)] shadow-sm focus-within:border-[var(--text-secondary)] focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-[var(--text)]">
      <Search :size="14" />
      <input class="h-full min-w-0 border-0 bg-transparent p-0 text-[var(--font-size-body)] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]" ref="searchInput" v-model="appStore.searchQuery" type="search" :placeholder="tr('sidebar.searchTasks')" :aria-label="tr('sidebar.searchTasks')" />
      <button class="icon-button inline-grid size-7 place-items-center rounded-md border-0 bg-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:bg-[var(--bg-active)] focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[var(--text)]" type="button" :title="tr('sidebar.closeSearch')" @click="toggleSearch"><X :size="14" /></button>
    </div>
    <p v-if="!collapsed && appStore.searchOpen" class="sidebar-search-help mx-5 mt-1 text-[calc(11px+var(--font-size-delta))] leading-relaxed text-[var(--text-muted)]">{{ tr("sidebar.searchHelp") }}</p>

    <div v-if="!collapsed" class="sidebar-section task-section min-h-0 flex-1 overflow-y-auto px-2.5 pt-1.5">
      <p v-if="appStore.catalogLoading" class="sidebar-empty mx-2 my-1 text-[var(--font-size-label)] leading-relaxed text-[var(--text-secondary)]">{{ tr("sidebar.loading") }}</p>
      <p v-else-if="!appStore.catalogReady && appStore.catalogError" class="sidebar-empty error-text mx-2 my-1 text-[var(--font-size-label)] leading-relaxed text-[var(--text-secondary)]" :title="appStore.catalogError">{{ tr("sidebar.unavailable") }}</p>
      <section v-if="!appStore.searchQuery.trim() && activeSessionThreads.length" class="active-sessions">
        <div class="active-session-heading">
          <button
            class="active-session-toggle"
            type="button"
            :aria-expanded="!activeSessionsCollapsed"
            :title="tr('sidebar.activeSessionsHelp')"
            @click="activeSessionsCollapsed = !activeSessionsCollapsed"
          >
            <ChevronRight v-if="activeSessionsCollapsed" :size="13" />
            <ChevronDown v-else :size="13" />
            <Zap :size="14" :stroke-width="1.7" />
            <span class="active-session-title">{{ tr("sidebar.activeSessions") }}</span>
            <span class="active-session-count">{{ activeSessionThreads.length }}</span>
          </button>
        </div>
        <div v-if="!activeSessionsCollapsed" class="active-session-list">
          <button
            v-for="thread in activeSessionThreads"
            :key="`active-${thread.id}`"
            :data-thread="thread.id"
            class="thread-row active-session-row"
            :class="{ 'is-active': appStore.activeThreadId === thread.id }"
            type="button"
            :aria-current="appStore.activeThreadId === thread.id ? 'true' : undefined"
            :title="activeSessionTooltip(thread)"
            @click="appStore.selectThread(thread.id)"
            @contextmenu.prevent="openTaskMenu($event, thread.id)"
          >
            <ThreadRowMarks :thread="thread" />
            <span class="thread-title min-w-0 flex-1 truncate" :class="{ 'is-started': thread.started }">{{ thread.title }}</span>
            <span class="active-session-workspace">{{ activeSessionLabel(thread) }}</span>
          </button>
        </div>
      </section>
      <div v-for="group in workspaceGroups" :key="group.workspace.id" class="workspace-group mt-1">
        <div class="workspace-header group flex h-8 min-w-0 items-center rounded-md border border-transparent hover:bg-[var(--bg-hover)] active:bg-[var(--bg-active)]">
          <input
            v-if="group.workspace.id === workspaceRenameID"
            id="workspace-rename-input"
            ref="workspaceRenameInput"
            v-model="workspaceRenameValue"
            class="h-6 w-full min-w-0 rounded-md border border-[var(--border-strong)] bg-[var(--bg-input)] px-2 text-[var(--font-size-body)] text-[var(--text)] outline-none"
            maxlength="200"
            :aria-label="tr('sidebar.renameWorkspace')"
            @click.stop
            @keydown.enter.prevent="submitWorkspaceRename()"
            @keydown.escape.prevent="cancelWorkspaceRename()"
            @blur="submitWorkspaceRename()"
          />
          <button
            v-else
            type="button"
            class="workspace-row flex h-full min-w-0 flex-1 items-center gap-2 rounded-md bg-transparent px-2 text-left text-[var(--font-size-body)] text-[var(--sidebar-workspace-text)] hover:bg-transparent"
            :aria-expanded="!isWorkspaceCollapsed(group.workspace.id)"
            :title="group.workspace.kind === 'ssh' ? group.workspace.remoteRoot : group.workspace.path"
            @click="toggleWorkspace(group.workspace.id)"
          >
            <Folder :size="18" :stroke-width="1.7" />
            <span class="workspace-name min-w-0 flex-1 truncate">{{ group.workspace.name }}</span>
            <span
              v-if="group.workspace.kind === 'ssh'"
              class="size-2 shrink-0 rounded-full border border-[var(--border-strong)]"
              :class="appStore.remoteWorkspaceHasConnection(group.workspace.id) ? 'border-none bg-[var(--green)]' : 'bg-transparent'"
              :title="tr(appStore.remoteWorkspaceHasConnection(group.workspace.id) ? 'sidebar.remoteConnected' : 'sidebar.remoteDisconnected')"
            />
            <span v-if="group.workspace.kind === 'ssh'" class="workspace-kind-tag shrink-0 rounded-full border border-[var(--border-strong)] bg-[var(--bg-workspace)] px-1.5 py-0.5 text-[calc(9px+var(--font-size-delta))] font-semibold text-[var(--text-secondary)]">{{ tr("sidebar.remoteDirectory") }}</span>
          </button>
          <template v-if="group.workspace.id !== workspaceRenameID">
            <button
              class="icon-button workspace-menu-button inline-grid size-8 shrink-0 place-items-center rounded-lg border-0 bg-transparent text-[var(--text-muted)] opacity-0 hover:text-[var(--text)] focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-50" :class="ui.iconButton"
              type="button"
              :aria-label="tr('sidebar.workspaceActions', { workspace: group.workspace.name })"
              :title="tr('sidebar.workspaceActions', { workspace: group.workspace.name })"
              :disabled="Boolean(workspaceActionID)"
              @click.stop="openWorkspaceMenu($event, group.workspace.id)"
            ><MoreHorizontal :size="16" /></button>
          </template>
        </div>
        <div v-if="!isWorkspaceCollapsed(group.workspace.id)" class="workspace-threads flex flex-col gap-1 p-0 pb-1">
          <button
            v-for="thread in group.threads"
            :key="thread.id"
            :data-thread="thread.id"
            class="thread-row flex h-8 w-full min-w-0 items-center gap-2 rounded-md bg-transparent pl-8 pr-2 text-left text-[var(--font-size-label)] text-[var(--sidebar-thread-text)] hover:bg-[var(--bg-hover)] hover:text-[var(--sidebar-thread-active-text)] active:bg-[var(--bg-active)]"
            :class="{ 'is-active': appStore.activeThreadId === thread.id }"
            type="button"
            :aria-current="appStore.activeThreadId === thread.id ? 'true' : undefined"
            :title="threadTooltip(thread)"
            @click="appStore.selectThread(thread.id)"
            @contextmenu.prevent="openTaskMenu($event, thread.id)"
          >
            <span class="thread-title min-w-0 flex-1 truncate" :class="{ 'is-started': thread.started }">{{ thread.title }}</span>
            <time v-if="relativeTime(thread.modifiedAt || thread.createdAt)" class="thread-time" :datetime="thread.modifiedAt || thread.createdAt">{{ relativeTime(thread.modifiedAt || thread.createdAt) }}</time>
            <ThreadRowMarks :thread="thread" />
          </button>
          <p v-if="group.threads.length === 0" class="sidebar-empty mx-2 my-1 text-[var(--font-size-label)] text-[var(--text-secondary)]">{{ tr("sidebar.noTasks") }}</p>
        </div>
      </div>
      <p v-if="workspaceActionError" class="sidebar-empty error-text mx-2 my-1 text-[var(--font-size-label)] text-[var(--red)]" role="alert">{{ workspaceActionError }}</p>
      <p v-if="!appStore.catalogLoading && appStore.workspaces.length === 0" class="sidebar-empty mx-2 my-1 text-[var(--font-size-label)] leading-relaxed text-[var(--text-secondary)]">{{ tr("sidebar.noWorkspaces") }}</p>
      <p v-else-if="appStore.searchQuery.trim() && workspaceGroups.length === 0" class="sidebar-empty mx-2 my-1 text-[var(--font-size-label)] leading-relaxed text-[var(--text-secondary)]">{{ tr("sidebar.noMatches") }}</p>
    </div>

    <div v-if="!collapsed" class="sidebar-footer h-11 shrink-0 items-center gap-2 border-t border-[var(--border)] px-3 text-[var(--font-size-label)] text-[var(--text-secondary)]">
      <RuntimeBadge />
      <button class="icon-button inline-grid size-8 place-items-center rounded-lg border border-transparent bg-transparent text-[var(--text-muted)] hover:border-[var(--border)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:bg-[var(--bg-active)]" :class="ui.iconButton" type="button" :title="tr('sidebar.settings')" @click="appStore.openSettings()">
        <Settings :size="17" />
      </button>
    </div>

    <div
      v-if="!appStore.sidebarCollapsed && taskMenu.open && taskMenuThread"
      class="thread-context-menu"
      :class="ui.menuSurface"
      role="menu"
      :style="{ left: `${taskMenu.x}px`, top: `${taskMenu.y}px` }"
      @click.stop="closeTaskMenu"
      @contextmenu.prevent
    >
      <button v-if="taskMenuWorkspace?.kind !== 'ssh'" type="button" role="menuitem" @click="void openTaskWorkspace()"><FolderOpen :size="14" />{{ tr("sidebar.openWorkspace") }}</button>
      <button type="button" role="menuitem" @click="void beginTaskRename()"><Pencil :size="14" />{{ tr("topbar.rename") }}</button>
      <button type="button" role="menuitem" :disabled="!taskMenuThread.sessionFile || Boolean(appStore.activeSessionOperation)" @click="void runTaskAction('branch')"><GitBranch :size="14" />{{ tr("topbar.branches") }}</button>
      <button type="button" role="menuitem" :disabled="!taskMenuThread.sessionFile || Boolean(appStore.activeSessionOperation) || Boolean(appStore.sessionMutationErrorByThread[taskMenuThread.id])" @click="void runTaskAction('clone')"><Copy :size="14" />{{ tr("topbar.clone") }}</button>
      <button type="button" role="menuitem" :disabled="!taskMenuThread.sessionFile || Boolean(appStore.activeSessionOperation)" @click="void runTaskAction('export')"><Download :size="14" />{{ tr("topbar.export") }}</button>
      <button type="button" role="menuitem" :disabled="!taskMenuThread.started" @click="void runTaskAction('compact')"><Sparkles :size="14" />{{ tr("topbar.compact") }}</button>
      <button v-if="taskMenuThread.started" type="button" role="menuitem" @click="void appStore.reloadThreadResources(taskMenuThread.id)"><RefreshCw :size="14" />{{ tr("sidebar.reloadPi") }}</button>
      <button v-if="taskMenuThread.started" type="button" role="menuitem" @click="void appStore.stopThread(taskMenuThread.id)"><Square :size="14" />{{ tr("sidebar.closePi") }}</button>
      <button v-else type="button" role="menuitem" @click="appStore.startThreadInBackground(taskMenuThread.id)"><Play :size="14" />{{ tr("sidebar.startPi") }}</button>
      <button type="button" role="menuitem" class="danger" @click="appStore.requestDeleteThread(taskMenuThread.id)"><Trash2 :size="14" />{{ tr("sidebar.delete") }}</button>
    </div>

    <form
      v-if="!appStore.sidebarCollapsed && taskRenameOpen"
      class="thread-context-menu task-rename-menu"
      role="dialog"
      :aria-label="tr('topbar.rename')"
      :style="{ left: `${taskMenu.x}px`, top: `${taskMenu.y}px` }"
      @click.stop
      @submit.prevent="void submitTaskRename()"
    >
      <label for="task-rename-input">{{ tr("topbar.taskName") }}</label>
      <input id="task-rename-input" ref="taskRenameInput" v-model="taskRenameValue" maxlength="200" />
      <div class="workspace-rename-actions">
        <button class="task-rename-confirm" type="submit" :disabled="!taskRenameValue.trim()">{{ tr("common.confirm") }}</button>
        <button class="task-rename-cancel" type="button" @click="closeTaskRename">{{ tr("common.cancel") }}</button>
      </div>
    </form>

    <div
      v-if="!appStore.sidebarCollapsed && workspaceMenu.open && workspaceMenuItem"
      class="thread-context-menu workspace-context-menu"
      :class="ui.menuSurface"
      role="menu"
      :style="{ left: `${workspaceMenu.x}px`, top: `${workspaceMenu.y}px` }"
      @click.stop="closeWorkspaceMenu"
      @contextmenu.prevent
    >
      <button type="button" role="menuitem" @click="void runWorkspaceAction('newTask')"><SquarePen :size="15" />{{ tr("sidebar.newTask") }}</button>
      <button v-if="workspaceMenuItem.kind !== 'ssh'" type="button" role="menuitem" @click="void runWorkspaceAction('open')"><FolderOpen :size="15" />{{ tr("sidebar.openWorkspace") }}</button>
      <template v-else>
        <button v-if="!appStore.remoteWorkspaceHasConnection(workspaceMenuItem.id)" type="button" role="menuitem" @click="void runWorkspaceAction('connect')"><Plug :size="15" />{{ tr("sidebar.connectRemote") }}</button>
        <button v-else type="button" role="menuitem" @click="void runWorkspaceAction('disconnect')"><Unplug :size="15" />{{ tr("sidebar.disconnectRemote") }}</button>
      </template>
      <button type="button" role="menuitem" @click="void openWorkspaceRename()"><Pencil :size="15" />{{ tr("sidebar.renameWorkspace") }}</button>
      <button type="button" role="menuitem" class="danger" @click="openWorkspaceRemoval"><Trash2 :size="15" />{{ tr("sidebar.removeWorkspace") }}</button>
    </div>
    <RemoveWorkspaceDialog
      v-if="workspaceRemovalItem"
      :workspace-name="workspaceRemovalItem.name"
      :busy="workspaceActionID === workspaceRemovalItem.id"
      :error="workspaceActionError"
      @cancel="closeWorkspaceRemoval"
      @remove="void confirmWorkspaceRemoval(false)"
      @delete="void confirmWorkspaceRemoval(true)"
    />
  </aside>
</template>
