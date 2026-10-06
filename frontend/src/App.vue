<script setup lang="ts">
import { System } from "@wailsio/runtime";
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AboutDialog from "./components/AboutDialog.vue";
import AppSidebar from "./components/AppSidebar.vue";
import AppTopbar from "./components/AppTopbar.vue";
import BranchDialog from "./components/BranchDialog.vue";
import ConversationPane from "./components/ConversationPane.vue";
import DeleteSessionDialog from "./components/DeleteSessionDialog.vue";
import ExtensionDialog from "./components/ExtensionDialog.vue";
import ExportResultDialog from "./components/ExportResultDialog.vue";
import InspectorPanel from "./components/InspectorPanel.vue";
import NewTaskDialog from "./components/NewTaskDialog.vue";
import OrphanSessionsDialog from "./components/OrphanSessionsDialog.vue";
import RemoteReconnectDialog from "./components/RemoteReconnectDialog.vue";
import ScheduledTasksPage from "./components/ScheduledTasksPage.vue";
import PaneResizer from "./components/PaneResizer.vue";
import WindowControls from "./components/WindowControls.vue";
import { tr } from "./i18n";
import { onBrowserEvent } from "./services/browser";
import { installGhostSelectionGuard } from "./services/ghostSelectionGuard";
import { PANEL_SETTLE_MS } from "./utils/paneMotion";
import { sanitizeFontFamilyList } from "./utils/fontFamily";
import { anchoredTranscriptTint, legibleCodeColor, TRANSCRIPT_TINT_ANCHOR } from "./utils/transcriptTint";
import {
  MAX_INSPECTOR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_INSPECTOR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useAppStore,
} from "./stores/app";

const appStore = useAppStore();
const SettingsDialog = defineAsyncComponent(() => import("./components/SettingsDialog.vue"));
const isWindows = ref(System.IsWindows());
// `window._wails.environment` 在部分 Wails 版本里要等 runtime ready 才注入，
// 同步读会拿到 false，所以再补一条 UA 兼容路径（后面的 Environment() 会再校准一次）。
const isMac = ref(System.IsMac() || /Macintosh|Mac OS X/.test(navigator.userAgent));
const systemDark = ref(window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
let colorSchemeQuery: MediaQueryList | undefined;
let disposeBrowserEvents: (() => void) | undefined;
let disposeGhostSelectionGuard: (() => void) | undefined;
function syncSystemColorScheme(event: MediaQueryListEvent) {
  systemDark.value = event.matches;
}
const darkSurface = computed(() => (
  appStore.appearance === "dark" || (appStore.appearance === "system" && systemDark.value)
));
const codeTheme = computed(() => (darkSurface.value ? appStore.darkCodeTheme : appStore.lightCodeTheme));
const windowTitle = computed(() => appStore.activePage === "scheduledTasks"
  ? tr("scheduledTasks.title")
  : appStore.activeExtensionTitle || appStore.activeThread?.title || "Pi Desk");

async function detectWindows() {
  try {
    const environment = await System.Environment();
    if (!isWindows.value) isWindows.value = environment.OS === "windows";
    isMac.value = environment.OS === "darwin";
  } catch {
    isWindows.value = false;
  }
}

function persistDesktopState() {
  void appStore.persistDesktopState();
}

function syncDocumentTheme(theme: string) {
  document.documentElement.dataset.theme = theme;
}

// `custom` is the one case the stylesheet cannot enumerate: the family name comes from the reader, so
// it is written onto the root as a value and consumed by `:root[data-font-family="custom"]` in
// tokens.css. The sanitiser is what makes that safe to do at all - see `utils/fontFamily.ts` for why a
// typed name cannot be validated and only previewed.
function syncDocumentFont(font: string, custom: string) {
  document.documentElement.dataset.fontFamily = font;
  const list = sanitizeFontFamilyList(custom);
  if (font === "custom" && list) {
    document.documentElement.style.setProperty("--font-interface-custom", list);
    return;
  }
  document.documentElement.style.removeProperty("--font-interface-custom");
}

function syncDocumentFontSize(size: number) {
  document.documentElement.dataset.fontSize = String(size);
}

// The attribute, not a style: tokens.css owns the three weight names so a future "follow the Pi
// theme" setting has one place to remap them, and `data-*` on the root is how every other
// document-level preference already gets in (theme / font family / font size).
function syncDocumentTranscriptWeight(weight: string) {
  document.documentElement.dataset.transcriptWeight = weight;
}

function syncDocumentTranscriptLineHeight(height: string) {
  document.documentElement.dataset.transcriptLineHeight = height;
}

// Pane motion · the inspector (right: 文件 / 终端 / 变更 tabs).
// `is-inspector-open` is what reserves the space (`workbench.css` puts `padding-right` on the
// transcript and the composer from it) *and* what parks the panel at `transform: none`. So the class
// cannot simply follow `inspectorOpen`:
//   - on open, a node inserted while the class is already on it has no previous computed value to
//     interpolate from, and no transition runs - hence the two-frame `inspectorReserve = false` hold.
//     Holding it also stops the slide from replaying on every session switch (`:key` remounts the
//     panel while the class never changes).
//   - on close, the node has to outlive the class by one transition or the panel is unmounted before
//     the first frame of its own slide-out - hence `inspectorMounted` + `PANEL_SETTLE_MS`.
const inspectorVisible = computed(() => appStore.inspectorOpen && appStore.activePage === "task");
const inspectorMounted = ref(inspectorVisible.value);
const inspectorReserve = ref(inspectorVisible.value);
let inspectorSettleTimer: number | undefined;
let inspectorEnterToken = 0;
const nextFrame = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

function clearInspectorSettle() {
  if (inspectorSettleTimer === undefined) return;
  window.clearTimeout(inspectorSettleTimer);
  inspectorSettleTimer = undefined;
}

async function playInspectorEnter(token: number) {
  inspectorReserve.value = false;
  inspectorMounted.value = true;
  await nextFrame();
  if (token !== inspectorEnterToken) return;
  inspectorReserve.value = true;
}

watch(inspectorVisible, (visible) => {
  clearInspectorSettle();
  if (visible) {
    void playInspectorEnter(++inspectorEnterToken);
    return;
  }
  inspectorEnterToken += 1;
  inspectorReserve.value = false;
  inspectorSettleTimer = window.setTimeout(() => {
    inspectorSettleTimer = undefined;
    if (!inspectorVisible.value) inspectorMounted.value = false;
  }, PANEL_SETTLE_MS);
});

// The reader's pick is anchored to the surface it is about to tint, then written onto the root as two
// custom properties - an arbitrary colour has no closed set of values for a stylesheet to enumerate,
// and removing both (the 跟随主题 state) falls back to the identity mix in tokens.css.
// The anchor is a constant mirrored from tokens.css rather than read back from it: this watch fires on
// the same appearance change as `syncDocumentTheme`, and whichever runs first would otherwise be
// asking the *old* theme what its lightness is. `tokens.test.ts` pins the two against each other.
function syncDocumentTranscriptTint(tint: string, strength: number, dark: boolean) {
  const style = document.documentElement.style;
  if (!tint) {
    style.removeProperty("--transcript-tint");
    style.removeProperty("--transcript-tint-strength");
    return;
  }
  style.setProperty("--transcript-tint", anchoredTranscriptTint(tint, dark ? TRANSCRIPT_TINT_ANCHOR.dark : TRANSCRIPT_TINT_ANCHOR.light) || tint);
  style.setProperty("--transcript-tint-strength", `${strength}%`);
}

async function initializeDesktop() {
  await appStore.initialize();
  appStore.startScheduledTaskScheduler();
  void appStore.checkScheduledTasks();
  if (window.innerWidth < 1280) appStore.inspectorOpen = false;
}

onMounted(() => {
  disposeBrowserEvents = onBrowserEvent(event => appStore.handleBrowserEvent(event));
  disposeGhostSelectionGuard = installGhostSelectionGuard();
  window.addEventListener("beforeunload", persistDesktopState);
  colorSchemeQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  colorSchemeQuery?.addEventListener("change", syncSystemColorScheme);
  void detectWindows();
  void initializeDesktop();
});

onBeforeUnmount(() => {
  clearInspectorSettle();
  disposeBrowserEvents?.();
  disposeGhostSelectionGuard?.();
  window.removeEventListener("beforeunload", persistDesktopState);
  colorSchemeQuery?.removeEventListener("change", syncSystemColorScheme);
  appStore.stopScheduledTaskScheduler();
  persistDesktopState();
});

watch(windowTitle, (title) => {
  document.title = title === "Pi Desk" ? title : `${title} - Pi Desk`;
}, { immediate: true });

watch(() => appStore.appearance, syncDocumentTheme, { immediate: true });
watch(() => [appStore.interfaceFont, appStore.interfaceFontCustom] as const, ([font, custom]) => syncDocumentFont(font, custom), { immediate: true });
watch(() => appStore.interfaceFontSize, syncDocumentFontSize, { immediate: true });
watch(() => appStore.transcriptFontWeight, syncDocumentTranscriptWeight, { immediate: true });
watch(() => appStore.transcriptLineHeight, syncDocumentTranscriptLineHeight, { immediate: true });
watch(() => [appStore.transcriptTint, appStore.transcriptTintStrength, darkSurface.value] as const, ([tint, strength, dark]) => syncDocumentTranscriptTint(tint, strength, dark), { immediate: true });

// The inline-code accent is a foreground, so it cannot be mixed into the theme the way the ground tint
// is: the reader wants that exact hue on the code spans. `legibleCodeColor` therefore walks only its
// lightness until it clears AA against the theme's own conversation ground, and the pill's grey ground
// and outline are dropped here so the colour is the whole signal - that is the "只渲染成特定颜色" the
// TUI does, where a token is coloured text and never a slab.
function syncDocumentCodeAccent(accent: string, dark: boolean) {
  const root = document.documentElement.style;
  const color = accent ? legibleCodeColor(accent, dark) : "";
  if (!color) {
    root.removeProperty("--code-inline-color");
    root.removeProperty("--code-inline-bg");
    root.removeProperty("--code-inline-border");
    return;
  }
  root.setProperty("--code-inline-color", color);
  root.setProperty("--code-inline-bg", "transparent");
  root.setProperty("--code-inline-border", "transparent");
}

watch(() => [appStore.codeAccent, darkSurface.value] as const, ([accent, dark]) => syncDocumentCodeAccent(accent, dark), { immediate: true });
</script>

<template>
  <div
    v-if="!appStore.desktopStateReady"
    class="app-shell startup-shell relative grid h-full w-full grid-cols-1 grid-rows-1 place-items-center overflow-hidden bg-[var(--bg-app)] font-body text-[var(--text)] antialiased"
    :data-theme="appStore.appearance"
    :data-code-theme="codeTheme"
    :data-code-line-numbers="appStore.showCodeLineNumbers ? 'show' : 'hide'"
    :data-code-wrap="appStore.wrapCodeLines ? 'wrap' : 'scroll'"
    :style="{
      '--sidebar-width': `${appStore.sidebarWidth}px`,
      '--inspector-width': `${appStore.inspectorWidth}px`,
      '--code-font-size': `${appStore.codeFontSize}px`,
    }"
    role="status"
    aria-label="Pi Desk"
  >
    <span class="startup-mark grid size-9 place-items-center rounded-lg border border-[var(--border-strong)] bg-[var(--bg-raised)] text-sm font-bold shadow-sm">Pi</span>
  </div>
  <div
    v-else
    class="app-shell relative grid h-full w-full grid-rows-[var(--topbar-height)_minmax(0,1fr)] overflow-clip bg-[var(--bg-app)] font-body text-[var(--text)] antialiased max-[760px]:[grid-template-columns:var(--sidebar-collapsed-width)_minmax(0,1fr)]"
    :data-theme="appStore.appearance"
    :data-code-theme="codeTheme"
    :data-code-line-numbers="appStore.showCodeLineNumbers ? 'show' : 'hide'"
    :data-code-wrap="appStore.wrapCodeLines ? 'wrap' : 'scroll'"
    :style="{
      '--sidebar-width': `${appStore.sidebarWidth}px`,
      '--inspector-width': `${appStore.inspectorWidth}px`,
      '--code-font-size': `${appStore.codeFontSize}px`,
    }"
    :class="{
      'is-windows': isWindows,
      'is-mac': isMac,
      'is-sidebar-collapsed': appStore.sidebarCollapsed,
      'is-inspector-closed': !appStore.inspectorOpen || appStore.activePage === 'scheduledTasks',
      'is-inspector-expanded': appStore.inspectorOpen && appStore.activePanel?.expanded && appStore.activePage === 'task',
      'is-inspector-open': inspectorReserve,
      '[grid-template-columns:var(--sidebar-collapsed-width)_minmax(0,1fr)]': appStore.sidebarCollapsed,
      '[grid-template-columns:var(--sidebar-width)_minmax(0,1fr)]': !appStore.sidebarCollapsed,
    }"
  >
    <AppTopbar v-show="!appStore.settingsOpen" />
    <AppSidebar v-show="!appStore.settingsOpen" />
    <PaneResizer
      v-if="!appStore.settingsOpen && !appStore.sidebarCollapsed"
      side="left"
      :value="appStore.sidebarWidth"
      :min="MIN_SIDEBAR_WIDTH"
      :max="MAX_SIDEBAR_WIDTH"
      :label="tr('topbar.resizeTaskSidebar')"
      @resize="appStore.setSidebarWidth($event)"
      @commit="appStore.setSidebarWidth($event, true)"
    />
    <main v-show="!appStore.settingsOpen" class="workspace-shell relative z-0 col-start-2 row-start-2 grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-[var(--bg-workspace)]">
      <ScheduledTasksPage v-if="appStore.activePage === 'scheduledTasks'" />
      <ConversationPane v-else />
    </main>
    <InspectorPanel v-if="inspectorMounted" :key="appStore.activeThreadId" v-show="!appStore.settingsOpen" />
    <PaneResizer
      v-if="!appStore.settingsOpen && inspectorReserve && !appStore.activePanel?.expanded && appStore.activePage === 'task'"
      side="right"
      :value="appStore.inspectorWidth"
      :min="MIN_INSPECTOR_WIDTH"
      :max="MAX_INSPECTOR_WIDTH"
      :label="tr('topbar.resizeInspector')"
      @resize="appStore.setInspectorWidth($event)"
      @commit="appStore.setInspectorWidth($event, true)"
    />
    <WindowControls :is-windows="isWindows" />
    <NewTaskDialog v-if="appStore.newTaskOpen" />
    <SettingsDialog v-if="appStore.settingsOpen" />
    <AboutDialog v-if="appStore.aboutOpen" />
    <OrphanSessionsDialog v-if="appStore.orphanSessionsOpen" />
    <RemoteReconnectDialog v-if="appStore.remoteReconnectOpen" />
    <BranchDialog v-if="appStore.branchPanelOpen" />
    <DeleteSessionDialog v-if="appStore.deleteDialogOpen" />
    <ExportResultDialog v-if="appStore.exportDialogOpen" />
    <ExtensionDialog v-if="appStore.activeThreadId && appStore.extensionRequestByThread[appStore.activeThreadId]" />
  </div>
</template>
