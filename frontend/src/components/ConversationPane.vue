<script setup lang="ts">
import { ui } from "../ui/classes";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { ArrowDown } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from "vue";
import ComposerBar from "./ComposerBar.vue";
import ConversationMessage from "./ConversationMessage.vue";
import SearchPopover from "./SearchPopover.vue";
import { useAppStore } from "../stores/app";
import { CONVERSATION_VIRTUALIZATION_THRESHOLD, estimateMessageSize, shouldVirtualizeMessages } from "../utils/conversationVirtualization";
import { isNearBottom, createSettleSnap, nestedScrollerCanGoUp, nextTailScroll, TAIL_PIN_OFFSET } from "../utils/scroll";
import { PANEL_MOTION_MS, PANEL_SETTLE_MS } from "../utils/paneMotion";
import { streamTuning } from "../utils/streamTuning";
import { groupConversationTurns } from "../utils/conversationGrouping";
import { tr } from "../i18n";
import LoadingRing from "./LoadingRing.vue";

const appStore = useAppStore();
const timeline = ref<HTMLElement>();
const composerBar = ref<ComponentPublicInstance>();
const composerHeight = ref(0);
const searchPopover = ref<InstanceType<typeof SearchPopover>>();
const searchOpen = ref(false);
const searchQuery = ref("");
const activeSearchMatch = ref(0);
const stickToBottom = ref(true);
const messages = computed(() => groupConversationTurns(appStore.activeMessages));
// The gate has to read the transcript that is actually on screen. It used to fall back to
// `thread.messageCount`, which is only ever written when a transcript is re-read from disk
// (`stores/app.ts` loadThreadTranscript) - so a long session grew inside this process without ever
// crossing the threshold, dragged like mud, and went smooth again after a restart on the *same*
// history. Grouped turns are also the wrong unit: one run of a few huge answers stays far under 80.
const shouldVirtualize = computed(() => shouldVirtualizeMessages(messages.value)
  || appStore.activeMessages.length > CONVERSATION_VIRTUALIZATION_THRESHOLD);
const lastMessage = computed(() => messages.value.at(-1));
// The run's own liveness, not `waitingForOutput`: that flag also drops for the gap
// between a tool call and its answer, and a snap there would yank the tail to the
// bottom in the middle of a live run.
const streamLive = computed(() => lastMessage.value?.streaming === true);
const streamSignal = computed(() => {
  const message = lastMessage.value;
  if (!message) return [appStore.activeThreadId, "", 0, 0, 0, 0, "", appStore.activeWaitingForOutput] as const;
  let thinkingLength = message.thinking.length;
  let toolCount = message.tools.length;
  let toolOutput = message.tools.reduce((total, tool) => total + tool.output.length, 0);
  // Merged assistant runs keep thinking and tools inside executionSteps with
  // message.tools/thinking emptied out, so growth has to be read from there.
  for (const step of message.executionSteps ?? []) {
    if (step.kind === "thinking" && step.text) thinkingLength += step.text.length;
    for (const tool of step.tools ?? []) {
      toolCount += 1;
      toolOutput += tool.output.length;
    }
  }
  return [appStore.activeThreadId, message.id, message.text.length, thinkingLength, toolCount, toolOutput, message.runNotice?.status ?? "", appStore.activeWaitingForOutput] as const;
});

/**
 * The virtualizer keeps its own copy of the scroll offset and only learns of a raw
 * `scrollTop` write from the scroll event, one task later. So the first range after a switch -
 * or after a cold transcript lands - is computed from offset 0: a block of rows from the
 * *top* of the list, which the tail pin then throws away. Measured on the 2112-entry session
 * (`.pi/bin/hitprobe/devSwitchProbe.ts.keep`, 2026-09-30): wave one mounted 27 rows, the whole
 * switch 55 mounts for the 7 rows that survive.
 *
 * Narrowing overscan to nothing while that pin is in flight keeps the throwaway block to the
 * couple of rows the estimate puts in the viewport. Two frames is the hand-off; if the window
 * is occluded and rAF stalls, the worst case is a narrow overscan until the next scroll event.
 */
const pinWindow = ref(false);
let pinFrames = 0;
function openPinWindow() {
  pinWindow.value = true;
  cancelAnimationFrame(pinFrames);
  let waited = 0;
  const step = () => {
    // Closed as soon as the virtualizer has seen the pin. Asking it for its offset directly is
    // private API, and the range it computes answers the same question: once the last row is
    // inside the range, the offset it used was the bottom.
    const items = virtualizer.value.getVirtualItems();
    const last = messages.value.length - 1;
    if (last >= 0 && items.length && items[items.length - 1].index >= last) {
      pinWindow.value = false;
      return;
    }
    if (++waited >= 4) {
      pinWindow.value = false;
      return;
    }
    pinFrames = requestAnimationFrame(step);
  };
  pinFrames = requestAnimationFrame(step);
}

// A cold transcript arriving is the same race as a thread change: the rows appear before the
// virtualizer has seen the pin.
watch(() => appStore.transcriptStateByThread[appStore.activeThreadId ?? ""], (state, previous) => {
  if (previous === "loading" && state === "loaded") openPinWindow();
});

// `overscan` counts *rows*. One merged turn measures 1439-1874px against an 856px viewport, so
// six of them put six whole rows off screen (probe: 完全屏外=6/7). Ask for a pixel band instead:
// one screen of slack above and below, never more than the six rows the old constant gave.
const viewportHeight = ref(0);
const virtualOverscan = computed(() => {
  const list = messages.value;
  const height = viewportHeight.value;
  if (!list.length || height <= 0) return 6;
  let total = 0;
  for (const message of list) total += estimateMessageSize(message);
  const average = Math.max(60, total / list.length);
  return Math.max(1, Math.min(6, Math.round((1.2 * height) / average)));
});

function noteViewportHeight() {
  const element = timeline.value;
  if (element && element.clientHeight > 0) viewportHeight.value = element.clientHeight;
}

const virtualizer = useVirtualizer(computed(() => ({
  count: shouldVirtualize.value ? messages.value.length : 0,
  getScrollElement: () => timeline.value ?? null,
  getItemKey: (index: number) => messages.value[index]?.turnKey ?? messages.value[index]?.id ?? index,
  estimateSize: (index: number) => estimateMessageSize(messages.value[index]),
  overscan: pinWindow.value ? 0 : virtualOverscan.value,
})));


const virtualRows = computed(() => virtualizer.value.getVirtualItems());
const virtualTotalSize = computed(() => virtualizer.value.getTotalSize());

type SearchMatch = { messageId: string; messageIndex: number };
type ConversationNavigationItem = SearchMatch & { title: string; answer: string };

function previewText(text: string, maxLength = 120): string {
  const normalized = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, tr("conversation.imagePlaceholder"))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[\\`*_>#~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

const navigationItems = computed<ConversationNavigationItem[]>(() => messages.value.flatMap((message, messageIndex) => {
  if (message.role !== "user") return [];
  const nextMessage = messages.value[messageIndex + 1];
  const answer = nextMessage?.role === "assistant" ? nextMessage.text : "";
  return [{
    messageId: message.id,
    messageIndex,
    title: previewText(message.text) || tr("conversation.navigationUntitled"),
    answer: previewText(answer) || tr("conversation.navigationNoAnswer"),
  }];
}));
const activeNavigationId = ref("");
const hoveredNavigationId = ref("");
const hoveredNavigationTop = ref(0);
const hoverClearTimer = ref<number>();
const hoveredNavigationItem = computed(() => navigationItems.value.find((item) => item.messageId === hoveredNavigationId.value));

function findMatches(text: string, query: string): number {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 0;
  const haystack = text.toLocaleLowerCase();
  let count = 0;
  let from = 0;
  while (true) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return count;
    count += 1;
    from = index + needle.length;
  }
}

const searchMatches = computed<SearchMatch[]>(() => {
  const query = searchQuery.value;
  if (!query.trim()) return [];
  return messages.value.flatMap((message, messageIndex) => Array.from(
    { length: findMatches(message.text, query) },
    () => ({ messageId: message.id, messageIndex }),
  ));
});
const currentSearchMatch = computed(() => searchMatches.value[activeSearchMatch.value]);
const searchResultLabel = computed(() => searchMatches.value.length
  ? `${activeSearchMatch.value + 1} / ${searchMatches.value.length}`
  : tr("conversation.searchResults", { count: 0 }));
const activeSearchMessageId = computed(() => currentSearchMatch.value?.messageId ?? "");
// The conversation counter walks *occurrences inside one message*, so the current hit also knows
// which occurrence it is. It goes to the answer body only (see ConversationMessage): the hit list
// counts `message.text`, and an ordinal for a thinking/tool block would name a mark the counter
// never counted. A message that is not the active one gets `search-active="false"`, so MarkdownBody
// leaves every mark dim no matter what ordinal it is handed.
const activeSearchHitIndex = computed(() => {
  const match = currentSearchMatch.value;
  if (!match) return undefined;
  return searchMatches.value
    .slice(0, activeSearchMatch.value)
    .filter((item) => item.messageId === match.messageId).length;
});

function measureVirtualRow(element: Element | ComponentPublicInstance | null) {
  if (!(element instanceof Element)) return;
  virtualizer.value.measureElement(element);
  observeRowOutput(element);
}

// A panel closing above a streaming answer shrinks the document between two
// frames, and the browser clamps scrollTop in that same frame; a rAF re-pin
// therefore lands one painted frame late, which is the flick readers see when
// a reasoning window collapses. ResizeObserver runs after layout and before
// paint, so it is where the correction belongs.
let rowObserver: ResizeObserver | undefined;
// A virtualized list mounts a fresh row element on every scroll, and the old ones leave the
// document without anything to unsubscribe them. Keeping them observed made the callback
// fire for rows that render nothing any more - the browser reports the resulting churn as
// `ResizeObserver loop completed with undelivered notifications`.
const observedRows = new Set<Element>();

function observeRowOutput(element: Element) {
  rowObserver ??= new ResizeObserver(() => {
    // A pane drag changes this row's box on every frame, and this callback answers by writing
    // scrollTop - a forced synchronous layout each time, which then invalidates style for the
    // whole tree. Nothing it computes is needed until the drag ends, so it stands down for the
    // duration and the watcher below catches up on release (see appStore.setPaneResizing).
    if (appStore.paneResizing) return;
    // No `measureElement` here. The virtualizer's offsets are what place a row on screen, so
    // feeding live measurements back from the observer that a position change itself wakes
    // up made the estimates and the measurements trade turns every frame - the viewport then
    // alternates between two positions (a screen recording of a 354-line session showed
    // ~1500px apart at ~15Hz). Height changes are absorbed by keeping the estimate stable
    // across a row's whole life instead - see estimatedChangedFilesSize.
    noteSelfGrowth();
    if (stickToBottom.value) followTail();
  });
  if (!observedRows.has(element)) {
    observedRows.add(element);
    rowObserver.observe(element);
  }
  for (const row of observedRows) {
    if (row.isConnected) continue;
    observedRows.delete(row);
    rowObserver.unobserve(row);
  }
}

function observeTranscriptRow(ref: Element | ComponentPublicInstance | null) {
  const element = ref instanceof Element ? ref : ref?.$el instanceof Element ? ref.$el : null;
  if (element) observeRowOutput(element);
}

function scrollToBottom() {
  const element = timeline.value;
  // Pin to the exact bottom (padding included) so the streaming tail stays
  // visible above the floating composer; estimate-based scrollToIndex fights
  // the ResizeObserver size corrections while content streams in.
  // Write an oversized offset and let the engine clamp it instead of reading
  // `scrollHeight` first: this runs right after the composer's new padding
  // landed, so the read would force a synchronous layout of the whole
  // transcript - the third forced layout of a single Enter keystroke.
  // It has to stay under 2^31 though: WebKit drops any bigger write at 0, which
  // reads as "pressing Enter throws the transcript to the top" (TAIL_PIN_OFFSET).
  if (element) element.scrollTop = TAIL_PIN_OFFSET;
}

// The follow is one frame chain, not one scroll per event: several ResizeObserver
// callbacks and stream signals land inside a single frame, and chasing each of them
// would force extra layouts and let intermediate offsets reach the screen.
let tailFrame = 0;
// Our own writes to scrollTop come back as scroll events - synchronously in some
// engines, on the next frame in others. Both cases have to be recognised, or the
// follow reads its own steps as "the reader left the tail" and releases itself.
let applyingTail = false;

// The end of a run delivers its height in mixed-sign batches inside ~1.2s of the
// scroll.stop edge: `agent_end` collapses the execution panels and inserts the
// changed-files card, `agent_settled` replaces the transcript rows with their
// persisted versions, and the repository refresh runs after that. Widening the snap band
// only during that window changes nothing else: an upward wheel still releases the
// follow, and once it expires the configured easing is back.
const settleSnap = createSettleSnap(1200);
watch(streamLive, (live, wasLive) => {
  if (wasLive === true && !live) settleSnap.arm();
});

// A pane toggle re-wraps the entire transcript. Opening the inspector takes the reading column from
// 1386px of content to 786px (measured in the sandbox window), so every visible row changes height on
// every frame of the 220ms slide - and easing a tail chase against a height that is still landing is
// precisely the overshoot-and-reverse a reader calls 跳动. Same shape as the end-of-run batch above,
// so the same remedy: pin instead of ease, for as long as the motion plus the unmount settle lasts.
// The metric is `gapReversals` in .pi/bin/hitprobe/devPaneJumpProbe.ts.keep - the number of times the
// per-frame displacement of the transcript's bottom edge flips sign inside one toggle. Before this
// window existed, one open measured 3 reversals and one rail expand measured 7.
const paneMotionSnap = createSettleSnap(PANEL_MOTION_MS + PANEL_SETTLE_MS);

// The snap band alone is not enough, and measuring why is what found the real cause: the follow is
// only ever *invoked* from the row ResizeObserver, and during a 220ms re-wrap there are frames where
// the document grows (a row further up crosses a line-count boundary) while none of the observed rows
// changes size. The follow sits those frames out, the tail lands 18-54px short, and the next
// correction overcompensates - a +-36px oscillation with 3 sign reversals inside one open
// (devPaneJumpProbe s4.after.open). So for the duration of the motion the follow is driven by the
// frame clock as well - and the frame clock that matters is the one that runs *after* layout.
// A rAF pin was tried first and measured no better (rAF is before this frame's style recalc, so it
// pins against the previous frame's box); a ResizeObserver callback is the after-layout, before-paint
// hook, which is the same reason the row observer above exists.
let paneMotionObserver: ResizeObserver | undefined;
let paneMotionTimer = 0;
function stopPaneMotionPin() {
  paneMotionObserver?.disconnect();
  paneMotionObserver = undefined;
  if (paneMotionTimer) window.clearTimeout(paneMotionTimer);
  paneMotionTimer = 0;
}
function pinTailThroughPaneMotion() {
  const element = timeline.value;
  stopPaneMotionPin();
  if (!element) return;
  paneMotionObserver = new ResizeObserver(() => {
    if (appStore.paneResizing) return;
    if (stickToBottom.value) followTail();
  });
  // The scroller's own content box is what the transition animates (`padding: 24px
  // var(--conversation-inline-space)`), so this fires on every frame of the slide - unlike the row
  // observer, which only wakes when one of the observed rows changes size.
  paneMotionObserver.observe(element);
  paneMotionTimer = window.setTimeout(stopPaneMotionPin, PANEL_MOTION_MS + PANEL_SETTLE_MS);
}

watch(() => [appStore.inspectorOpen, appStore.sidebarCollapsed] as const, () => {
  paneMotionSnap.arm();
  pinTailThroughPaneMotion();
});
// The row observer stands down during a pane drag; this is where the tail catches up once the
// width has settled.
watch(() => appStore.paneResizing, (resizing) => {
  if (resizing) return;
  noteViewportHeight();
  if (stickToBottom.value) followTail();
});


/**
 * Move the tail one step and report whether a jump is still in flight. The step itself
 * runs in the caller's frame on purpose: a ResizeObserver callback is the last place
 * before paint where correcting the offset is invisible, and deferring it to a rAF is
 * what made a collapsing panel flick a frame ago.
 */
function stepTail(): boolean {
  const element = timeline.value;
  if (!element || !stickToBottom.value) return false;
  const next = nextTailScroll(
    element.scrollTop,
    element.scrollHeight,
    element.clientHeight,
    // Either window pins: they are independent causes with the same remedy, and `limit` answers
    // either the configured band or Infinity, so the wider one wins.
    Math.max(
      settleSnap.limit(streamTuning.scroll.snapWithinPx),
      paneMotionSnap.limit(streamTuning.scroll.snapWithinPx),
    ),
  );
  if (next !== element.scrollTop) {
    applyingTail = true;
    element.scrollTop = next;
    applyingTail = false;
  }
  const chasing = element.scrollHeight - element.scrollTop - element.clientHeight > 1;
  if (!chasing) updateActiveNavigation();
  return chasing;
}

function followTail() {
  if (!stepTail()) return;
  if (tailFrame) return;
  tailFrame = requestAnimationFrame(() => {
    tailFrame = 0;
    if (stepTail()) followTail();
  });
}

function stopFollowingTail() {
  if (!tailFrame) return;
  cancelAnimationFrame(tailFrame);
  tailFrame = 0;
}

// A trackpad flick only moves 40-90px, so a wide "near bottom" band treated the
// first flicks as "still at the tail": the next animation frame pinned the bottom
// again and the transcript yanked itself away mid-read. Resuming the follow now
// needs an actual arrival at the bottom, and an upward wheel releases the pin
// straight from the gesture instead of waiting for a sampled scroll event.
// How close to the bottom counts as "still with us". Shared with the capped output
// windows (utils/innerTail) through the config file.
const followResumePx = () => streamTuning.scroll.resumeWithinPx;

// A scroll event is only evidence about the reader when the reader caused it. Two other
// sources move the position on their own: our own eased steps, and the browser's scroll
// anchoring, which compensates scrollTop whenever content *above* the viewport changes
// height - which is every frame of a streamed answer, since reasoning and tool panels
// grow and collapse up there. Reading an anchoring step as "they left the tail" disarms
// the follow in the middle of a run, and the transcript then stops moving while text keeps
// arriving until the reader drags themselves back down.
//
// So: real input (wheel, pointer, key) always wins; a bare scroll event that lands while
// we are still writing content is ignored; anything else keeps the old contract.
const SELF_GROWTH_GRACE_MS = 250;
// Momentum scrolling keeps emitting scroll events after the last wheel event, so the
// reader's own input has to be trusted for a while.
const INPUT_WINDOW_MS = 600;
let readerInputAt = 0;
let selfGrowthUntil = 0;

function markReaderInput() {
  readerInputAt = Date.now();
}

function noteSelfGrowth() {
  selfGrowthUntil = Date.now() + SELF_GROWTH_GRACE_MS;
}

function onTimelineScroll() {
  const element = timeline.value;
  if (!element) return;
  noteViewportHeight();
  // One of our own steps (in flight, or being written right now): the reader has not
  // moved, so the follow stays armed.
  if (applyingTail || tailFrame) {
    updateActiveNavigation();
    return;
  }
  const now = Date.now();
  if (now - readerInputAt > INPUT_WINDOW_MS && now < selfGrowthUntil) {
    updateActiveNavigation();
    return;
  }
  stickToBottom.value = isNearBottom(element.scrollTop, element.clientHeight, element.scrollHeight, followResumePx());
  if (!stickToBottom.value) stopFollowingTail();
  updateActiveNavigation();
}

function onTimelineWheel(event: WheelEvent) {
  if (event.deltaY >= 0) return;
  // Reasoning and tool panels are scroll containers of their own. While the
  // wheel is still feeding one of those, the timeline has not moved at all,
  // so releasing the follow would be wrong.
  if (nestedScrollerCanGoUp(event.target, timeline.value)) return;
  markReaderInput();
  stickToBottom.value = false;
  stopFollowingTail();
}

// The follow only resumes on an actual arrival at the bottom, so the reader
// needs one click to get back to a streaming tail instead of dragging.
function followLatest() {
  stickToBottom.value = true;
  scrollToBottom();
  updateActiveNavigation();
}
function updateActiveNavigation() {
  const element = timeline.value;
  if (!element || !navigationItems.value.length) return;

  if (shouldVirtualize.value) {
    const activeIndex = virtualRows.value.reduce((current, row) => (
      row.start <= element.scrollTop + 48 ? Math.max(current, row.index) : current
    ), 0);
    const activeItem = navigationItems.value.findLast((item) => item.messageIndex <= activeIndex);
    activeNavigationId.value = activeItem?.messageId ?? navigationItems.value[0].messageId;
    return;
  }

  const viewportTop = element.getBoundingClientRect().top + 48;
  const rows = Array.from(element.querySelectorAll<HTMLElement>('.message-row[data-role="user"]'));
  let activeId = "";
  for (const row of rows) {
    if (row.getBoundingClientRect().top <= viewportTop) activeId = row.dataset.messageId ?? activeId;
  }
  activeNavigationId.value = activeId || rows[0]?.dataset.messageId || activeNavigationId.value;
}

async function focusSearch() {
  await nextTick();
  searchPopover.value?.focus();
}

async function openSearch() {
  if (!appStore.activeThread) return;
  searchOpen.value = true;
  await focusSearch();
}

function closeSearch() {
  searchOpen.value = false;
  searchQuery.value = "";
  activeSearchMatch.value = 0;
}

async function scrollToMessage(messageIndex: number, messageId: string, block: ScrollLogicalPosition) {
  if (shouldVirtualize.value) virtualizer.value.scrollToIndex(messageIndex, { align: block === "start" ? "start" : "center" });
  await nextTick();
  const row = Array.from(timeline.value?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])
    .find((element) => element.dataset.messageId === messageId);
  if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ behavior: "smooth", block });
  updateActiveNavigation();
}

// A merged turn is one row that can run to thousands of pixels, so centring *the row* is what put the
// hit outside the viewport on both ends - measured in a real WKWebView against the shipped CSS
// (`.pi/bin/hitprobe/search-scroll.sh`): row-centring left the first hit 930px above the topbar and
// the last one 785px below the composer. So: the lit node, else any hit node in that row, else the
// row's top edge (`.timeline`'s scroll-padding-top keeps that below the title bar).
const searchHitSelectors = ["mark.markdown-search-hit.is-active", "mark.markdown-search-hit"];

function findSearchRow(scope: HTMLElement, messageId: string): HTMLElement | undefined {
  return Array.from(scope.querySelectorAll<HTMLElement>("[data-message-id]"))
    .find((candidate) => candidate.dataset.messageId === messageId);
}

// `scrollIntoView` is not enough on a virtualized transcript. Measured in the running dev instance
// (frontend/src/utils/devSearchProbe.ts, 2026-09-29 10:30): the virtualizer re-measures rows after
// we scroll, which moves the node we just aimed at - three consecutive "next" presses left
// `scrollTop` frozen at the same 26686, and another landed 21px above the scrollport. So the offset
// is computed here, and re-applied one frame later once the measurement pass has settled.
async function scrollToSearchMatch() {
  const match = currentSearchMatch.value;
  const element = timeline.value;
  if (!match || !element) return;
  if (shouldVirtualize.value) virtualizer.value.scrollToIndex(match.messageIndex, { align: "start" });
  await nextTick();
  let row = findSearchRow(element, match.messageId);
  // The virtualizer needs a frame or three to actually mount the row we just asked for. Without the
  // retry the first hit after typing was measured before it existed and nothing moved (probe:
  // scrollTop stayed 0 while the target sat 3113px down the document).
  for (let attempt = 0; !row && attempt < 4; attempt += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (shouldVirtualize.value) virtualizer.value.scrollToIndex(match.messageIndex, { align: "start" });
    await nextTick();
    row = findSearchRow(element, match.messageId);
  }
  if (!row) return;
  const target = searchHitSelectors
    .map((selector) => row.querySelector<HTMLElement>(selector))
    .find((candidate): candidate is HTMLElement => candidate !== null) ?? row;
  const style = getComputedStyle(element);
  // The two overlays the visible band is bounded by: the composer reserve is live (`composerHeight`
  // feeds it every time the input grows a line), and the top inset tracks the title bar.
  const insetTop = Number.parseFloat(style.scrollPaddingTop) || 0;
  const insetBottom = Number.parseFloat(style.scrollPaddingBottom) || 0;
  const band = Math.max(120, element.clientHeight - insetTop - insetBottom);
  const place = () => {
    const offset = element.scrollTop + (target.getBoundingClientRect().top - element.getBoundingClientRect().top);
    element.scrollTop = Math.max(0, offset - band / 2);
  };
  place();
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => { place(); resolve(); })));
  updateActiveNavigation();
}

async function scrollToNavigation(item: ConversationNavigationItem) {
  activeNavigationId.value = item.messageId;
  await scrollToMessage(item.messageIndex, item.messageId, "start");
}

function setHoveredNavigation(messageId: string, event: Event) {
  if (hoverClearTimer.value !== undefined) window.clearTimeout(hoverClearTimer.value);
  hoveredNavigationId.value = messageId;
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const outline = target.closest<HTMLElement>(".conversation-outline");
  if (!outline) return;
  const targetRect = target.getBoundingClientRect();
  hoveredNavigationTop.value = targetRect.top - outline.getBoundingClientRect().top + targetRect.height / 2;
}

function keepHoveredNavigation() {
  if (hoverClearTimer.value !== undefined) window.clearTimeout(hoverClearTimer.value);
}

function clearHoveredNavigation() {
  if (hoverClearTimer.value !== undefined) window.clearTimeout(hoverClearTimer.value);
  hoverClearTimer.value = window.setTimeout(() => {
    hoveredNavigationId.value = "";
    hoverClearTimer.value = undefined;
  }, 120);
}

function hideHoveredNavigation() {
  if (hoverClearTimer.value !== undefined) window.clearTimeout(hoverClearTimer.value);
  hoverClearTimer.value = undefined;
  hoveredNavigationId.value = "";
}

function moveSearchMatch(direction: 1 | -1) {
  const total = searchMatches.value.length;
  if (!total) return;
  activeSearchMatch.value = (activeSearchMatch.value + direction + total) % total;
  void scrollToSearchMatch();
}

function onDocumentKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") {
    if (!appStore.activeThread) return;
    // A rendered Markdown document in the inspector owns the shortcut: the reader is looking at that
    // document, and InspectorPanel's own handler is waiting for exactly this case.
    if (appStore.activeMarkdownPreviewVisible) return;
    event.preventDefault();
    void openSearch();
    return;
  }
  if (!searchOpen.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
  }
}

watch(() => composerBar.value?.$el, (element, _previous, onCleanup) => {
  if (!(element instanceof HTMLElement)) {
    composerHeight.value = 0;
    return;
  }
  const measureComposer = () => {
    const height = Math.ceil(element.getBoundingClientRect().height);
    if (height === composerHeight.value) return;
    composerHeight.value = height;
    void nextTick().then(() => {
      if (composerBar.value?.$el === element && stickToBottom.value) scrollToBottom();
    });
  };
  let resizeFrame = 0;
  const observer = new ResizeObserver(() => {
    // Same reason as the row observer: a pane drag resizes the composer every frame and
    // measuring it forces a synchronous layout. Stand down for the drag, catch up on release.
    if (appStore.paneResizing) return;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(measureComposer);
  });
  watch(() => appStore.paneResizing, (resizing) => {
    if (!resizing) measureComposer();
  });
  observer.observe(element);
  measureComposer();
  onCleanup(() => {
    observer.disconnect();
    cancelAnimationFrame(resizeFrame);
    stopPaneMotionPin();
  });
}, { flush: "post" });

watch(() => appStore.activeThreadId, async () => {
  activeNavigationId.value = navigationItems.value[0]?.messageId ?? "";
  stickToBottom.value = true;
  openPinWindow();
  await nextTick();
  // `measure()` used to sit here. It is `itemSizeCache.clear()` plus a notify, and the cache is
  // keyed by `turnKey` (a message id), so entries from other tasks can never be *wrong* - they are
  // simply the heights this row had the last time it was on screen. Clearing it meant every switch
  // back re-ranged the list from the character-count estimate, which caps at 900px against rows
  // measured at 1439-1874px: the probe counted 17 mounts for 8 distinct rows on the 653-entry task
  // (`.pi/bin/hitprobe/devSwitchProbe.ts.keep`, 2026-09-30 08:3x).
  scrollToBottom();
  updateActiveNavigation();
});

watch(streamSignal, (_signal, previous) => {
  const messageChanged = previous?.[1] !== lastMessage.value?.id;
  if (messageChanged && lastMessage.value?.role === "user") stickToBottom.value = true;
  noteSelfGrowth();
  if (stickToBottom.value) followTail();
});

watch(virtualTotalSize, () => {
  noteSelfGrowth();
  if (stickToBottom.value && shouldVirtualize.value) followTail();
});

watch(navigationItems, (items) => {
  if (!items.some((item) => item.messageId === activeNavigationId.value)) activeNavigationId.value = items[0]?.messageId ?? "";
}, { flush: "post" });

watch(searchQuery, () => {
  activeSearchMatch.value = 0;
  if (searchOpen.value) void nextTick().then(scrollToSearchMatch);
});

watch(searchMatches, (matches) => {
  activeSearchMatch.value = matches.length ? Math.min(activeSearchMatch.value, matches.length - 1) : 0;
}, { flush: "post" });

onMounted(async () => {
  document.addEventListener("keydown", onDocumentKeydown, true);
  // A thread that was already active when this pane mounted never runs the `activeThreadId` watcher
  // below, so nothing pinned the tail and the transcript opened at the top. Same shape as the switch
  // path - and deliberately without `measure()`: the row-height cache is keyed by `turnKey`, so the
  // heights this row had last time it was on screen are still the right ones (see the note there).
  stickToBottom.value = true;
  openPinWindow();
  await nextTick();
  noteViewportHeight();
  scrollToBottom();
  updateActiveNavigation();
});
onBeforeUnmount(() => {
  stopFollowingTail();
  cancelAnimationFrame(pinFrames);
  rowObserver?.disconnect();
  observedRows.clear();
  document.removeEventListener("keydown", onDocumentKeydown, true);
  hideHoveredNavigation();
});
</script>

<template>
  <section class="conversation-pane relative grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-[var(--bg-workspace)]" :class="ui.root" :aria-label="tr('conversation.label')">
    <SearchPopover
      v-if="searchOpen"
      ref="searchPopover"
      v-model:query="searchQuery"
      class="conversation-search absolute top-3 z-20 w-[min(360px,calc(100%_-_32px))]"
      :style="{ '--inspector-width': `${appStore.inspectorWidth}px` }"
      :has-matches="searchMatches.length > 0"
      :result-label="searchResultLabel"
      @next="moveSearchMatch(1)"
      @previous="moveSearchMatch(-1)"
      @close="closeSearch"
    />
    <div class="conversation-scroll-region relative min-h-0 min-w-0 overflow-hidden">
      <nav v-if="navigationItems.length" class="conversation-outline" :aria-label="tr('conversation.navigation')">
        <div class="conversation-outline-scroll" @scroll="hideHoveredNavigation">
          <div class="conversation-outline-list">
            <button
              v-for="(item, index) in navigationItems"
              :key="item.messageId"
              class="conversation-outline-item"
              :class="{ 'is-active': item.messageId === activeNavigationId, 'is-hovered': item.messageId === hoveredNavigationId }"
              type="button"
              :aria-label="tr('conversation.navigationItem', { index: index + 1, title: item.title })"
              @mouseenter="setHoveredNavigation(item.messageId, $event)"
              @mouseleave="clearHoveredNavigation"
              @focus="setHoveredNavigation(item.messageId, $event)"
              @blur="clearHoveredNavigation"
              @click="void scrollToNavigation(item)"
            >
              <span class="conversation-outline-line" aria-hidden="true" />
            </button>
          </div>
        </div>
        <aside
          v-if="hoveredNavigationItem"
          class="conversation-outline-preview"
          :style="{ top: `${hoveredNavigationTop}px` }"
          role="tooltip"
          @mouseenter="keepHoveredNavigation"
          @mouseleave="clearHoveredNavigation"
        >
          <strong>{{ hoveredNavigationItem.title }}</strong>
          <span><em>{{ tr("conversation.navigationAnswer") }}</em>{{ hoveredNavigationItem.answer }}</span>
        </aside>
      </nav>
      <div ref="timeline" class="timeline h-full w-full min-w-0 overflow-x-clip overflow-y-auto" role="log" aria-live="polite" :style="{ '--inspector-width': `${appStore.inspectorWidth}px`, '--composer-overlay-reserve': `${composerHeight}px` }" @scroll="onTimelineScroll" @wheel="onTimelineWheel" @pointerdown="markReaderInput" @keydown="markReaderInput">
      <div v-if="appStore.sessionMutationErrorByThread?.[appStore.activeThreadId]" class="conversation-operation-banner mb-4 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-[var(--font-size-label)] text-[var(--text-secondary)]" role="status">
        {{ tr("conversation.historyMutationLimit") }}
      </div>
      <div v-if="appStore.activeSessionOperation === 'Compacting'" class="conversation-operation-banner mb-4 inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-[var(--font-size-label)] text-[var(--text-secondary)] shadow-sm" role="status" aria-live="polite">
        <LoadingRing :size="14" />
        <span>{{ tr("topbar.compacting") }}</span>
      </div>
      <div v-if="!appStore.activeThread" class="empty-workspace h-full" aria-hidden="true" />

      <div v-else-if="messages.length === 0" class="empty-thread mx-auto grid min-h-80 max-w-xl content-center justify-items-start gap-3 text-left text-[var(--text-secondary)]">
        <LoadingRing v-if="appStore.transcriptStateByThread[appStore.activeThread.id] === 'loading'" :size="22" />
<!--        <History v-else-if="appStore.activeThread.sessionFile" :size="22" />
        <CircleDot v-else :size="22" />-->
        <strong class="font-display text-[var(--font-size-subheading)] font-semibold tracking-[-0.02em] text-[var(--text)]">{{ appStore.activeThread.sessionFile ? tr("conversation.previous") : tr("conversation.startIn", { workspace: appStore.activeThread.workspace }) }}</strong>
        <span class="max-w-[60ch] text-[var(--font-size-body)] leading-relaxed">{{ appStore.activeThread.messageCount ? tr("conversation.savedMessages", { count: appStore.activeThread.messageCount }) : appStore.activeThread.trust === "approve" ? tr("conversation.resourcesEnabled") : tr("conversation.resourcesDisabled") }}</span>
        <button
          v-if="appStore.activeThread.sessionFile && appStore.transcriptStateByThread[appStore.activeThread.id] !== 'loading'"
          class="text-button inline-flex h-9 items-center whitespace-nowrap rounded-lg border border-[var(--border-strong)] bg-[var(--bg-workspace)] px-3 text-[var(--font-size-body)] font-medium text-[var(--text-secondary)] shadow-sm hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:bg-[var(--bg-active)] focus-visible:outline-2 focus-visible:outline-[var(--text)]" :class="ui.button"
          type="button"
          @click="appStore.loadThreadTranscript(appStore.activeThread.id)"
        >
          {{ tr("conversation.open") }}
        </button>
      </div>

      <div
        v-else-if="shouldVirtualize"
        class="virtual-message-list"
        data-virtualized="true"
        :style="{ height: `${virtualTotalSize}px` }"
      >
        <!-- While the tail pin is still in flight the range would be computed from the old offset,
             so the rows it names are the ones at the *top* of the list: mounted, painted for one
             frame, and discarded by the pin. Render only the spacer (the container keeps its
             estimated height, which is what makes the pin land at the bottom) and mount the real
             rows once the offset has arrived. -->
        <div
          v-for="row in pinWindow ? [] : virtualRows"
          :key="String(row.key)"
          :ref="measureVirtualRow"
          class="virtual-message-row"
          :data-index="row.index"
          :style="{ transform: `translateY(${row.start}px)` }"
        >
          <ConversationMessage :message="messages[row.index]" :search-query="searchQuery" :search-active="messages[row.index]?.id === activeSearchMessageId" :search-active-index="activeSearchHitIndex" />
        </div>
      </div>

      <ConversationMessage v-else v-for="message in messages" :key="message.turnKey ?? message.id" :ref="observeTranscriptRow" :message="message" :search-query="searchQuery" :search-active="message.id === activeSearchMessageId" :search-active-index="activeSearchHitIndex" />
      <div
        v-if="appStore.activeWaitingForOutput && !appStore.activeRetry"
        class="waiting-for-output mt-3 inline-flex size-8 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text-secondary)] shadow-sm"
        role="status"
        aria-live="polite"
        :aria-label="tr('conversation.waitingForOutput')"
      >
        <LoadingRing :size="14" />
      </div>
      </div>
      <button
        v-if="!stickToBottom && messages.length"
        class="timeline-jump-latest"
        :style="{ '--inspector-width': `${appStore.inspectorWidth}px`, '--composer-overlay-reserve': `${composerHeight}px` }"
        type="button"
        :title="tr('conversation.jumpToLatest')"
        :aria-label="tr('conversation.jumpToLatest')"
        @click="followLatest"
      >
        <ArrowDown :size="16" aria-hidden="true" />
      </button>
    </div>
    <ComposerBar v-if="appStore.activeThread" ref="composerBar" />
  </section>
</template>
