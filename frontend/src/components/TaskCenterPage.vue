<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Archive, ArchiveRestore, RefreshCw, RotateCcw, Square } from "lucide-vue-next";
import type { TaskRunSummary, TaskUsageSummary } from "../../bindings/pi-desk/internal/domain";
import { tr } from "../i18n";
import { useTasksStore } from "../stores/tasks";
import { vSpin } from "../utils/spin";

const tasksStore = useTasksStore();
const payloadPreview = ref<{ text: string; x: number; y: number } | null>(null);
const detail = computed(() => tasksStore.detail);
const selectedRun = computed(() => tasksStore.selectedRun);
const activeRunStatuses = new Set(["queued", "running", "waiting_approval", "waiting_input"]);
const canCancel = computed(() => Boolean(detail.value && ["running", "queued", "waiting_approval", "waiting_input"].includes(detail.value.status)));
const canRetry = computed(() => Boolean(detail.value && ["failed", "cancelled"].includes(detail.value.status)));
const canArchive = computed(() => Boolean(
  detail.value && !detail.value.archivedAt && !(detail.value.runs ?? []).some((run) => activeRunStatuses.has(run.status)),
));
const canUnarchive = computed(() => Boolean(detail.value?.archivedAt));

const statusKeys: Record<string, string> = {
  created: "taskCenter.status.created",
  queued: "taskCenter.status.queued",
  running: "taskCenter.status.running",
  waiting_approval: "taskCenter.status.waitingApproval",
  waiting_input: "taskCenter.status.waitingInput",
  paused: "taskCenter.status.paused",
  completed: "taskCenter.status.completed",
  failed: "taskCenter.status.failed",
  cancelled: "taskCenter.status.cancelled",
};

const numberFormat = new Intl.NumberFormat();

function statusLabel(status: string): string {
  return tr(statusKeys[status] ?? "taskCenter.status.unknown");
}

function originLabel(origin: string): string {
  return tr(`taskCenter.origin.${origin}`) || origin;
}

function time(value?: number): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function formatUsage(usage?: TaskUsageSummary | null): string {
  if (!usage) return tr("taskCenter.noUsage");
  return [
    `${tr("taskCenter.input")} ${numberFormat.format(usage.inputTokens)}`,
    `${tr("taskCenter.output")} ${numberFormat.format(usage.outputTokens)}`,
    `${tr("taskCenter.cacheRead")} ${numberFormat.format(usage.cacheReadTokens)}`,
    `${tr("taskCenter.cacheWrite")} ${numberFormat.format(usage.cacheWriteTokens)}`,
  ].join(" · ");
}

function runLabel(run: TaskRunSummary): string {
  return `${run.id} · ${statusLabel(run.status)}`;
}

function previewPayload(payload: string): string {
  const compact = payload.replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 160)}…` : compact;
}

function showPayloadPreview(event: MouseEvent, payload: string) {
  if (!payload.trim()) return;
  payloadPreview.value = {
    text: payload,
    x: Math.min(event.clientX + 14, window.innerWidth - 440),
    y: Math.min(event.clientY + 14, window.innerHeight - 260),
  };
}

function movePayloadPreview(event: MouseEvent) {
  if (!payloadPreview.value) return;
  payloadPreview.value.x = Math.min(event.clientX + 14, window.innerWidth - 440);
  payloadPreview.value.y = Math.min(event.clientY + 14, window.innerHeight - 260);
}

function hidePayloadPreview() {
  payloadPreview.value = null;
}

onMounted(() => {
  void tasksStore.refresh();
});
</script>

<template>
  <section class="task-center">
    <header class="task-center-head">
      <div class="task-center-title">
        <h1>{{ tr("taskCenter.title") }}</h1>
        <p>{{ tr("taskCenter.subtitle") }}</p>
      </div>
      <div class="task-center-tools">
        <div class="task-view-tabs" role="tablist" :aria-label="tr('taskCenter.title')">
          <button
            class="task-view-tab"
            :class="{ 'is-active': tasksStore.view === 'active' }"
            type="button"
            role="tab"
            :aria-selected="tasksStore.view === 'active'"
            @click="tasksStore.setView('active')"
          >
            {{ tr("taskCenter.active") }}
          </button>
          <button
            class="task-view-tab"
            :class="{ 'is-active': tasksStore.view === 'archived' }"
            type="button"
            role="tab"
            :aria-selected="tasksStore.view === 'archived'"
            @click="tasksStore.setView('archived')"
          >
            {{ tr("taskCenter.archived") }}
          </button>
        </div>
        <button class="tc-button" type="button" :disabled="tasksStore.loading" @click="tasksStore.refresh()">
          <RefreshCw :size="15" v-spin="tasksStore.loading" :class="{ 'is-spinning': tasksStore.loading }" />
          <span>{{ tr("taskCenter.refresh") }}</span>
        </button>
      </div>
    </header>

    <p v-if="tasksStore.error" class="tc-error">{{ tasksStore.error }}</p>
    <p v-else-if="tasksStore.actionError" class="tc-error">{{ tasksStore.actionError }}</p>
    <p v-else-if="!tasksStore.enabled && !tasksStore.loading" class="tc-notice">{{ tr("taskCenter.disabled") }}</p>

    <div v-else class="task-center-body">
      <aside class="task-list" :aria-label="tr('taskCenter.title')">
        <button
          v-for="task in tasksStore.tasks"
          :key="task.id"
          class="task-row"
          :class="{ 'is-selected': task.id === tasksStore.selectedTaskID }"
          type="button"
          @click="tasksStore.select(task.id)"
        >
          <span class="task-row-title">{{ task.title }}</span>
          <span class="task-row-meta">
            <span class="status-dot" :class="`is-${task.status}`" />
            {{ statusLabel(task.status) }} · {{ originLabel(task.origin) }}
          </span>
          <span class="task-row-time">{{ time(task.updatedAt) }}</span>
        </button>
        <p v-if="!tasksStore.tasks.length" class="tc-empty">
          {{ tasksStore.view === "archived" ? tr("taskCenter.emptyArchived") : tr("taskCenter.empty") }}
        </p>
      </aside>

      <article class="task-detail">
        <template v-if="detail">
          <header class="task-detail-head">
            <div>
              <h2>{{ detail.title }}</h2>
              <p class="task-detail-id">{{ detail.id }}</p>
            </div>
            <div class="task-actions">
              <span class="status-chip" :class="`is-${detail.status}`">{{ statusLabel(detail.status) }}</span>
              <button v-if="canCancel" class="tc-button is-danger" type="button" :disabled="tasksStore.actionLoading" @click="tasksStore.cancelSelected()">
                <Square :size="13" />
                <span>{{ tasksStore.actionLoading ? tr("taskCenter.working") : tr("taskCenter.cancel") }}</span>
              </button>
              <button v-if="canRetry" class="tc-button" type="button" :disabled="tasksStore.actionLoading" @click="tasksStore.retrySelected()">
                <RotateCcw :size="13" />
                <span>{{ tasksStore.actionLoading ? tr("taskCenter.working") : tr("taskCenter.retry") }}</span>
              </button>
              <button v-if="canArchive" class="tc-button" type="button" :disabled="tasksStore.actionLoading" @click="tasksStore.archiveSelected()">
                <Archive :size="13" />
                <span>{{ tasksStore.actionLoading ? tr("taskCenter.working") : tr("taskCenter.archive") }}</span>
              </button>
              <button v-if="canUnarchive" class="tc-button" type="button" :disabled="tasksStore.actionLoading" @click="tasksStore.unarchiveSelected()">
                <ArchiveRestore :size="13" />
                <span>{{ tasksStore.actionLoading ? tr("taskCenter.working") : tr("taskCenter.unarchive") }}</span>
              </button>
            </div>
          </header>

          <dl class="task-meta">
            <div>
              <dt>{{ tr("taskCenter.originLabel") }}</dt>
              <dd>{{ originLabel(detail.origin) }}</dd>
            </div>
            <div>
              <dt>{{ tr("taskCenter.workspace") }}</dt>
              <dd>{{ detail.workspaceId || tr("taskCenter.noWorkspace") }}</dd>
            </div>
            <div>
              <dt>{{ tr("taskCenter.updated") }}</dt>
              <dd>{{ time(detail.updatedAt) }}</dd>
            </div>
          </dl>

          <section class="task-section">
            <h3>{{ tr("taskCenter.runs") }}</h3>
            <div class="run-list">
              <button
                v-for="run in detail?.runs ?? []"
                :key="run.id"
                class="run-row"
                :class="{ 'is-selected': run.id === tasksStore.selectedRunID }"
                type="button"
                @click="tasksStore.selectRun(run.id)"
              >
                <span class="run-row-main">{{ runLabel(run) }}</span>
                <span class="run-row-meta">{{ time(run.startedAt) }} → {{ time(run.finishedAt) }}</span>
                <span class="run-row-usage">{{ formatUsage(run.usage) }}</span>
              </button>
              <p v-if="!detail?.runs?.length" class="tc-empty">{{ tr("taskCenter.noRuns") }}</p>
            </div>
          </section>

          <section class="task-section">
            <h3>
              {{ tr("taskCenter.events") }}
              <span v-if="selectedRun" class="task-section-sub">· {{ selectedRun.id }}</span>
            </h3>
            <p v-if="tasksStore.eventsLoading" class="tc-empty">{{ tr("taskCenter.loading") }}</p>
            <ol v-else class="event-list">
              <li v-for="event in tasksStore.events" :key="event.id" class="event-row">
                <span class="event-type">{{ event.type }}</span>
                <span class="event-seq">#{{ event.seq }}</span>
                <time class="event-time">{{ time(event.createdAt) }}</time>
                <code
                  v-if="event.payload && event.payload !== '{}'"
                  class="event-payload"
                  :aria-label="event.payload"
                  @mouseenter="showPayloadPreview($event, event.payload)"
                  @mousemove="movePayloadPreview"
                  @mouseleave="hidePayloadPreview"
                >{{ previewPayload(event.payload) }}</code>
              </li>
            </ol>
            <p v-if="!tasksStore.eventsLoading && !tasksStore.events.length" class="tc-empty">{{ tr("taskCenter.noEvents") }}</p>
          </section>
        </template>
        <p v-else class="tc-empty">{{ tr("taskCenter.select") }}</p>
      </article>
    </div>

    <pre
      v-if="payloadPreview"
      class="event-payload-tooltip"
      :style="{ left: `${payloadPreview.x}px`, top: `${payloadPreview.y}px` }"
    >{{ payloadPreview.text }}</pre>
  </section>
</template>

<style scoped>
.task-center {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 14px;
  padding: 20px 24px 24px;
  overflow: hidden;
  color: var(--text);
}

.task-center-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.task-center-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-view-tabs {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--border, #333);
  border-radius: 7px;
}

.task-view-tab {
  height: 26px;
  padding: 0 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-size-small, 12px);
}

.task-view-tab.is-active {
  background: var(--bg-hover, rgba(255, 255, 255, 0.08));
  color: var(--text);
}

.task-center-title h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.task-center-title p {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-size-small, 12px);
}

.tc-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-size-small, 12px);
}

.tc-button:hover:not(:disabled) {
  color: var(--text);
  background: var(--bg-hover, rgba(255, 255, 255, 0.06));
}

.tc-button:disabled {
  cursor: default;
  opacity: 0.6;
}

.tc-button.is-danger {
  color: var(--red, #e06c75);
  border-color: var(--red, #e06c75);
}

.task-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tc-error,
.tc-notice {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: var(--font-size-small, 12px);
}

.tc-error {
  color: var(--red, #e06c75);
}

.task-center-body {
  display: grid;
  grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
  gap: 16px;
  flex: 1;
  min-height: 0;
}

.task-list,
.task-detail {
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  background: var(--bg-panel, rgba(255, 255, 255, 0.02));
}

.task-list {
  display: flex;
  flex-direction: column;
  padding: 6px;
}

.task-row {
  display: grid;
  gap: 3px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.task-row:hover,
.task-row.is-selected {
  background: var(--bg-hover, rgba(255, 255, 255, 0.06));
}

.task-row.is-selected {
  border-color: var(--border, #333);
}

.task-row-title {
  overflow: hidden;
  font-size: var(--font-size-body, 13px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-row-meta,
.task-row-time {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 4px;
  border-radius: 50%;
  background: var(--text-secondary);
}

.status-dot.is-running,
.status-dot.is-queued {
  background: var(--amber, #d19a66);
}

.status-dot.is-completed {
  background: var(--green, #98c379);
}

.status-dot.is-failed,
.status-dot.is-cancelled {
  background: var(--red, #e06c75);
}

.task-detail {
  padding: 16px 18px;
}

.task-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.task-detail-head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.task-detail-id {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

.status-chip {
  padding: 3px 8px;
  border: 1px solid var(--border, #333);
  border-radius: 999px;
  font-size: 11px;
  white-space: nowrap;
}

.status-chip.is-running,
.status-chip.is-queued {
  color: var(--amber, #d19a66);
}

.status-chip.is-completed {
  color: var(--green, #98c379);
}

.status-chip.is-failed,
.status-chip.is-cancelled {
  color: var(--red, #e06c75);
}

.task-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 16px 0 0;
  padding: 12px;
  border: 1px solid var(--border, #333);
  border-radius: 6px;
}

.task-meta div {
  min-width: 0;
}

.task-meta dt {
  color: var(--text-secondary);
  font-size: 11px;
}

.task-meta dd {
  margin: 3px 0 0;
  overflow: hidden;
  font-size: var(--font-size-small, 12px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-section {
  margin-top: 18px;
}

.task-section h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.task-section-sub {
  color: var(--text-secondary);
  font-weight: 400;
}

.run-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.run-row {
  display: grid;
  gap: 3px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.run-row:hover,
.run-row.is-selected {
  background: var(--bg-hover, rgba(255, 255, 255, 0.06));
}

.run-row.is-selected {
  border-color: var(--accent, #61afef);
}

.run-row-main {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

.run-row-meta,
.run-row-usage {
  color: var(--text-secondary);
  font-size: 11px;
}

.event-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.event-row {
  display: grid;
  grid-template-columns: minmax(120px, 220px) 52px 150px minmax(0, 1fr);
  align-items: baseline;
  gap: 8px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border, #333);
  font-size: 11px;
}

.event-type {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-seq,
.event-time,
.event-payload {
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-payload {
  cursor: help;
  font-family: var(--font-mono, monospace);
}

.event-payload-tooltip {
  position: fixed;
  z-index: 30;
  width: min(420px, calc(100vw - 28px));
  max-height: 46vh;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid var(--border, #333);
  border-radius: 7px;
  background: var(--bg-panel, #20242a);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
  color: var(--text, #ddd);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.45;
  pointer-events: none;
  white-space: pre-wrap;
  word-break: break-word;
}

.tc-empty {
  margin: 10px 4px;
  color: var(--text-secondary);
  font-size: var(--font-size-small, 12px);
}

@media (max-width: 900px) {
  .task-center-body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(160px, 34%) minmax(0, 1fr);
  }

  .task-meta {
    grid-template-columns: 1fr;
  }

  .event-row {
    grid-template-columns: minmax(100px, 1fr) 44px 130px;
  }

  .event-payload {
    display: none;
  }
}
</style>
