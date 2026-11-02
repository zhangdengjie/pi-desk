<script setup lang="ts">
import { AlertTriangle, Download, RefreshCw } from "lucide-vue-next";
import { computed, onMounted, ref, watch } from "vue";
import type { UsageDayUsage, UsageReport } from "../../bindings/pi-desk/internal/domain";
import { tr } from "../i18n";
import { catalogService } from "../services/catalog";
import { useAppStore } from "../stores/app";
import { ui } from "../ui/classes";
import { vSpin } from "../utils/spin";

type RangeDays = 0 | 1 | 7 | 30;
type SortKey = "tokens" | "messages" | "sessions";
/** `auto` keeps the current B/M/K thresholds; the others force one unit down the whole table. */
type TokenUnit = "auto" | "K" | "M" | "B";

const appStore = useAppStore();

const ranges: { days: RangeDays; label: string }[] = [
  { days: 1, label: "usage.rangeToday" },
  { days: 7, label: "usage.rangeWeek" },
  { days: 30, label: "usage.rangeMonth" },
  { days: 0, label: "usage.rangeAll" },
];

const range = ref<RangeDays>(7);
const workspaceFilter = ref("");
const loading = ref(false);
const error = ref("");
const report = ref<UsageReport | null>(null);
const sortKey = ref<SortKey>("tokens");

const tokenUnits: { value: TokenUnit; label: string }[] = [
  { value: "auto", label: "usage.unitAuto" },
  { value: "K", label: "usage.unitK" },
  { value: "M", label: "usage.unitM" },
  { value: "B", label: "usage.unitB" },
];
const tokenUnit = ref<TokenUnit>("auto");

const workspacePath = computed(() => {
  const thread = appStore.activeThread;
  return thread?.workspacePath || appStore.workspaces.find((workspace) => workspace.id === thread?.workspaceId)?.path || "";
});
const totals = computed(() => report.value?.totals ?? null);
const days = computed(() => report.value?.days ?? []);
const workspaces = computed(() => report.value?.workspaces ?? []);
const sessions = computed(() => report.value?.sessions ?? []);
const models = computed(() => report.value?.topModels ?? []);
const coverage = computed(() => report.value?.coverage ?? null);
const isEmpty = computed(() => Boolean(report.value) && (totals.value?.sessions ?? 0) === 0);

const cacheHitRate = computed(() => {
  const tokens = totals.value?.tokens;
  if (!tokens) return null;
  const reusable = tokens.cacheRead;
  const denominator = tokens.input + tokens.cacheRead;
  if (denominator <= 0) return null;
  return reusable / denominator;
});

const zeroTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };

function localDateKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The chart always shows the whole selected window, so a quiet day is a gap rather than a
 * surprise; "all time" simply uses whatever days the report came back with.
 */
const chartDays = computed<UsageDayUsage[]>(() => {
  if (range.value === 0) return days.value;
  const byDate = new Map(days.value.map((day) => [day.date, day]));
  const today = new Date();
  const result: UsageDayUsage[] = [];
  for (let offset = range.value - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const key = localDateKey(date);
    result.push(byDate.get(key) ?? { date: key, tokens: zeroTokens, cost: 0, messages: 0, sessions: 0 });
  }
  return result;
});

const chartMax = computed(() => chartDays.value.reduce((max, day) => Math.max(max, day.tokens.total), 0));

/**
 * The chart lives inside a horizontally scrollable box, so an absolutely positioned card would be
 * clipped by it. The card is teleported to <body> and positioned from the column's viewport rect.
 */
const TOOLTIP_WIDTH = 208;
const hovered = ref<{ day: UsageDayUsage; left: number; top: number; below: boolean } | null>(null);

function showDayTooltip(day: UsageDayUsage, event: Event) {
  const element = event.currentTarget as HTMLElement | null;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const half = TOOLTIP_WIDTH / 2;
  const left = Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8);
  // Flip under the column when there is no room above it (the chart is tall, the topbar is not).
  const below = rect.top < 170;
  hovered.value = { day, left, top: below ? rect.bottom + 8 : rect.top - 8, below };
}

function hideDayTooltip() {
  hovered.value = null;
}

function daySummary(day: UsageDayUsage): string {
  return `${day.date} · ${formatTokens(day.tokens.total)}`;
}

const sortedWorkspaces = computed(() => {
  const rows = [...workspaces.value];
  rows.sort((a, b) => {
    if (sortKey.value === "messages") return b.messages - a.messages;
    if (sortKey.value === "sessions") return b.sessions - a.sessions;
    return b.tokens.total - a.tokens.total;
  });
  return rows;
});

const numberFormat = new Intl.NumberFormat();

function formatTokens(value: number): string {
  return numberFormat.format(Math.round(value || 0));
}

function formatCompact(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (magnitude >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (magnitude >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return `${Math.round(value)}`;
}

/**
 * Token counts are the only column where a forced unit helps: mixing 149.8M and 420.8K down one
 * column makes the rows hard to compare. Counts (messages/sessions) keep `formatCompact`.
 */
function formatTokenCompact(value: number): string {
  const scaled = (divisor: number, suffix: string, digits: number) =>
    `${numberFormat.format(Number((value / divisor).toFixed(digits)))}${suffix}`;
  switch (tokenUnit.value) {
    case "K":
      return scaled(1e3, "K", 1);
    case "M":
      return scaled(1e6, "M", 1);
    case "B":
      return scaled(1e9, "B", 2);
    default:
      return formatCompact(value);
  }
}

function formatCost(value: number): string {
  return `$${value.toFixed(value >= 100 ? 2 : 4)}`;
}

/** Providers that do not report billing send 0; a column of "$0.0000" reads as a bug, so say so. */
function formatCostCell(value: number): string {
  return value > 0 ? formatCost(value) : "—";
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function formatBytes(value: number): string {
  if (value >= 1 << 30) return `${(value / (1 << 30)).toFixed(1)} GB`;
  if (value >= 1 << 20) return `${(value / (1 << 20)).toFixed(1)} MB`;
  if (value >= 1 << 10) return `${(value / (1 << 10)).toFixed(0)} KB`;
  return `${value} B`;
}

function shortDate(date: string): string {
  return date.length >= 10 ? date.slice(5) : date;
}

/** Table cells are narrow: `MM-DD HH:mm` fits a 20% column, the full stamp stays in the title. */
function formatTableStamp(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const month = `${parsed.getMonth() + 1}`.padStart(2, "0");
  const day = `${parsed.getDate()}`.padStart(2, "0");
  const hours = `${parsed.getHours()}`.padStart(2, "0");
  const minutes = `${parsed.getMinutes()}`.padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

function formatStamp(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function shareOfTotal(value: number): number {
  const total = totals.value?.tokens.total ?? 0;
  return total > 0 ? value / total : 0;
}

function barHeight(day: UsageDayUsage): string {
  if (chartMax.value <= 0 || day.tokens.total <= 0) return "0%";
  return `${Math.max((day.tokens.total / chartMax.value) * 100, 2)}%`;
}

function segmentGrow(day: UsageDayUsage): { cache: number; input: number; output: number; other: number } {
  const total = day.tokens.total || 0;
  const named = day.tokens.cacheRead + day.tokens.input + day.tokens.output;
  return {
    cache: day.tokens.cacheRead,
    input: day.tokens.input,
    output: day.tokens.output,
    other: Math.max(total - named, 0),
  };
}

function sessionLabel(row: { title: string; path: string }): string {
  if (row.title.trim()) return row.title;
  const parts = row.path.split("/");
  return parts[parts.length - 1] || row.path;
}

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    report.value = await catalogService.getUsageReport({
      workspacePath: workspaceFilter.value || undefined,
      days: range.value,
      topN: 20,
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

function selectRange(next: RangeDays) {
  range.value = next;
}

function selectWorkspace(path: string) {
  workspaceFilter.value = path;
}

function clearWorkspaceFilter() {
  workspaceFilter.value = "";
}

function toggleSort(next: SortKey) {
  sortKey.value = next;
}

function exportCSV() {
  const current = report.value;
  if (!current) return;
  const rows = [["date", "tokens", "input", "output", "cacheRead", "cacheWrite", "reasoning", "cost", "messages", "sessions"]];
  for (const day of current.days ?? []) {
    rows.push([
      day.date, `${day.tokens.total}`, `${day.tokens.input}`, `${day.tokens.output}`,
      `${day.tokens.cacheRead}`, `${day.tokens.cacheWrite}`, `${day.tokens.reasoning}`,
      day.cost.toFixed(6), `${day.messages}`, `${day.sessions}`,
    ]);
  }
  const blob = new Blob([rows.map((row) => row.join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `pi-desk-usage-${range.value === 0 ? "all" : `${range.value}d`}-${localDateKey(new Date())}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

watch([range, workspaceFilter], () => {
  hideDayTooltip();
  void refresh();
});
onMounted(() => { void refresh(); });
</script>

<template>
  <section class="usage-page" :class="ui.root" :aria-label="tr('usage.title')" @scroll="hideDayTooltip">
    <header class="usage-header">
      <h1>{{ tr("usage.title") }}</h1>
      <p v-if="totals" class="usage-header-meta">{{ tr("usage.messagesCount", { count: formatTokens(totals.messages) }) }}</p>
    </header>

    <div class="usage-toolbar">
      <div class="usage-ranges" role="tablist" :aria-label="tr('usage.range')">
        <button
          v-for="option in ranges"
          :key="option.days"
          type="button"
          role="tab"
          :aria-selected="range === option.days"
          @click="selectRange(option.days)"
        >{{ tr(option.label) }}</button>
      </div>
      <div class="usage-units" role="group" :aria-label="tr('usage.tokenUnit')">
        <span class="usage-units-label">{{ tr("usage.tokenUnit") }}</span>
        <button
          v-for="unit in tokenUnits"
          :key="unit.value"
          type="button"
          :aria-pressed="tokenUnit === unit.value"
          @click="tokenUnit = unit.value"
        >{{ tr(unit.label) }}</button>
      </div>
      <div class="usage-actions">
        <button type="button" class="usage-scope" :aria-pressed="workspaceFilter === ''" @click="clearWorkspaceFilter">{{ tr("usage.scopeAll") }}</button>
        <button type="button" class="usage-scope" :aria-pressed="workspaceFilter === workspacePath" :disabled="!workspacePath" @click="selectWorkspace(workspacePath)">{{ tr("usage.scopeCurrent") }}</button>
        <button type="button" class="usage-action" :disabled="!report" @click="exportCSV"><Download :size="14" />{{ tr("usage.exportCsv") }}</button>
        <button type="button" class="usage-action" :disabled="loading" @click="void refresh()"><RefreshCw v-spin="loading" :size="14" />{{ tr("usage.refresh") }}</button>
      </div>
    </div>

    <p v-if="workspaceFilter" class="usage-filter" :title="workspaceFilter">
      <span class="usage-filter-path">{{ workspaceFilter }}</span>
      <button type="button" class="usage-filter-clear" @click="clearWorkspaceFilter">{{ tr("usage.clearFilter") }}</button>
    </p>

    <div v-if="loading && !report" class="usage-loading">
      <RefreshCw v-spin :size="18" class="is-spinning" />
      <span>{{ tr("usage.loading") }}</span>
    </div>
    <p v-else-if="error" class="usage-error"><AlertTriangle :size="15" />{{ error }}</p>

    <template v-else-if="report && totals">
      <div v-if="isEmpty" class="usage-empty">
        <strong>{{ tr("usage.emptyTitle") }}</strong>
        <span>{{ tr("usage.emptyBody") }}</span>
      </div>

      <div class="usage-kpis">
        <section class="usage-kpi">
          <span>{{ tr("usage.kpiTokens") }}</span>
          <strong :title="formatTokens(totals.tokens.total)">{{ formatTokenCompact(totals.tokens.total) }}</strong>
          <small>{{ tr("usage.legendInput") }} {{ formatTokenCompact(totals.tokens.input) }} · {{ tr("usage.legendOutput") }} {{ formatTokenCompact(totals.tokens.output) }}</small>
        </section>
        <section class="usage-kpi">
          <span>{{ tr("usage.kpiMessages") }}</span>
          <strong :title="formatTokens(totals.messages)">{{ formatCompact(totals.messages) }}</strong>
          <small>{{ tr("usage.kpiSessions") }} {{ formatTokens(totals.sessions) }}</small>
        </section>
        <section class="usage-kpi">
          <span>{{ tr("usage.kpiCacheHit") }}</span>
          <strong>{{ cacheHitRate === null ? "—" : formatPercent(cacheHitRate) }}</strong>
          <small :title="tr('usage.kpiCacheHitHelp')">{{ formatTokenCompact(totals.tokens.cacheRead) }}</small>
        </section>
        <section class="usage-kpi">
          <span>{{ tr("usage.kpiCost") }}</span>
          <strong>{{ formatCost(totals.cost) }}</strong>
          <small v-if="totals.cost <= 0">{{ tr("usage.costZeroNote") }}</small>
        </section>
      </div>

      <section class="usage-panel">
        <header class="usage-panel-head">
          <h2>{{ tr("usage.trend") }}</h2>
          <p>{{ tr("usage.trendHelp") }}</p>
        </header>
        <div class="usage-legend">
          <span class="usage-legend-item"><i class="usage-swatch is-cache"></i>{{ tr("usage.legendCacheRead") }}</span>
          <span class="usage-legend-item"><i class="usage-swatch is-input"></i>{{ tr("usage.legendInput") }}</span>
          <span class="usage-legend-item"><i class="usage-swatch is-output"></i>{{ tr("usage.legendOutput") }}</span>
          <span class="usage-legend-item"><i class="usage-swatch is-other"></i>{{ tr("usage.legendOther") }}</span>
        </div>
        <div class="usage-chart" :class="{ 'is-dense': chartDays.length > 14 }">
          <button
            v-for="day in chartDays"
            :key="day.date"
            type="button"
            class="usage-chart-column"
            :aria-label="daySummary(day)"
            @mouseenter="showDayTooltip(day, $event)"
            @focus="showDayTooltip(day, $event)"
            @mouseleave="hideDayTooltip"
            @blur="hideDayTooltip"
          >
            <span class="usage-chart-track">
              <span class="usage-chart-bar" :style="{ height: barHeight(day) }">
                <span class="usage-chart-segment is-other" :style="{ flexGrow: segmentGrow(day).other }"></span>
                <span class="usage-chart-segment is-output" :style="{ flexGrow: segmentGrow(day).output }"></span>
                <span class="usage-chart-segment is-input" :style="{ flexGrow: segmentGrow(day).input }"></span>
                <span class="usage-chart-segment is-cache" :style="{ flexGrow: segmentGrow(day).cache }"></span>
              </span>
            </span>
            <span class="usage-chart-label">{{ shortDate(day.date) }}</span>
          </button>
        </div>
        <Teleport to="body">
          <div
            v-if="hovered"
            class="usage-chart-tooltip"
            :class="{ 'is-below': hovered.below }"
            role="tooltip"
            :style="{ left: `${hovered.left}px`, top: `${hovered.top}px`, width: `${TOOLTIP_WIDTH}px` }"
          >
            <strong>{{ hovered.day.date }}</strong>
            <dl>
              <div><dt>{{ tr("usage.kpiTokens") }}</dt><dd>{{ formatTokens(hovered.day.tokens.total) }}</dd></div>
              <div><dt>{{ tr("usage.legendCacheRead") }}</dt><dd>{{ formatTokens(hovered.day.tokens.cacheRead) }}</dd></div>
              <div><dt>{{ tr("usage.legendInput") }}</dt><dd>{{ formatTokens(hovered.day.tokens.input) }}</dd></div>
              <div><dt>{{ tr("usage.legendOutput") }}</dt><dd>{{ formatTokens(hovered.day.tokens.output) }}</dd></div>
              <div><dt>{{ tr("usage.kpiMessages") }}</dt><dd>{{ formatTokens(hovered.day.messages) }}</dd></div>
              <div><dt>{{ tr("usage.kpiSessions") }}</dt><dd>{{ formatTokens(hovered.day.sessions) }}</dd></div>
            </dl>
          </div>
        </Teleport>
      </section>

      <section class="usage-panel">
        <header class="usage-panel-head">
          <h2>{{ tr("usage.workspaces") }}</h2>
        </header>
        <table class="usage-table is-workspaces">
          <thead>
            <tr>
              <th scope="col">{{ tr("usage.workspaceName") }}</th>
              <th scope="col" class="is-numeric">
                <button type="button" :aria-pressed="sortKey === 'tokens'" @click="toggleSort('tokens')">{{ tr("usage.columnTokens") }}</button>
              </th>
              <th scope="col" class="is-numeric">
                <button type="button" :aria-pressed="sortKey === 'messages'" @click="toggleSort('messages')">{{ tr("usage.columnMessages") }}</button>
              </th>
              <th scope="col" class="is-numeric">
                <button type="button" :aria-pressed="sortKey === 'sessions'" @click="toggleSort('sessions')">{{ tr("usage.columnSessions") }}</button>
              </th>
              <th scope="col" class="is-numeric">{{ tr("usage.columnShare") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="workspace in sortedWorkspaces" :key="workspace.path || workspace.name">
              <td class="usage-cell-name">
                <button type="button" class="usage-link" :title="workspace.path || workspace.name" @click="selectWorkspace(workspace.path)">{{ workspace.name || tr("usage.unknownWorkspace") }}</button>
              </td>
              <td class="usage-cell-number" :title="formatTokens(workspace.tokens.total)">{{ formatTokenCompact(workspace.tokens.total) }}</td>
              <td class="usage-cell-number">{{ formatTokens(workspace.messages) }}</td>
              <td class="usage-cell-number">{{ formatTokens(workspace.sessions) }}</td>
              <td class="usage-cell-number">{{ formatPercent(shareOfTotal(workspace.tokens.total)) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <div class="usage-columns">
        <section class="usage-panel">
          <header class="usage-panel-head">
            <h2>{{ tr("usage.sessions") }}</h2>
          </header>
          <table class="usage-table is-sessions">
            <thead>
              <tr>
                <th scope="col">{{ tr("usage.sessionTitle") }}</th>
                <th scope="col" class="is-numeric">{{ tr("usage.columnTokens") }}</th>
                <th scope="col" class="is-numeric">{{ tr("usage.sessionUpdated") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in sessions" :key="row.path">
                <td class="usage-cell-name">
                  <span class="usage-session-title" :title="row.path">{{ sessionLabel(row) }}</span>
                  <small class="usage-session-meta">{{ row.model || tr("usage.unknownModel") }} · {{ formatTokens(row.messages) }}</small>
                </td>
                <td class="usage-cell-number" :title="formatTokens(row.tokens.total)">{{ formatTokenCompact(row.tokens.total) }}</td>
                <td class="usage-cell-time" :title="formatStamp(row.updatedAt)">{{ formatTableStamp(row.updatedAt) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!sessions.length" class="usage-panel-empty">{{ tr("usage.emptyTitle") }}</p>
        </section>

        <section class="usage-panel">
          <header class="usage-panel-head">
            <h2>{{ tr("usage.models") }}</h2>
          </header>
          <table class="usage-table is-models">
            <thead>
              <tr>
                <th scope="col">{{ tr("usage.sessionModel") }}</th>
                <th scope="col" class="is-numeric">{{ tr("usage.columnTokens") }}</th>
                <th scope="col" class="is-numeric">{{ tr("usage.kpiCost") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="model in models" :key="`${model.provider}/${model.model}`">
                <td class="usage-cell-name">
                  <span class="usage-session-title">{{ model.model || tr("usage.unknownModel") }}</span>
                  <small class="usage-session-meta">{{ model.provider || tr("usage.unknownWorkspace") }}</small>
                </td>
                <td class="usage-cell-number" :title="formatTokens(model.tokens.total)">{{ formatTokenCompact(model.tokens.total) }}</td>
                <td class="usage-cell-number">{{ formatCostCell(model.cost) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!models.length" class="usage-panel-empty">{{ tr("usage.emptyTitle") }}</p>
        </section>
      </div>

      <footer v-if="coverage" class="usage-coverage">
        <span>{{ tr("usage.coverage", { files: formatTokens(coverage.filesScanned), bytes: formatBytes(coverage.bytesRead), skipped: formatTokens(coverage.filesSkipped) }) }}</span>
        <span v-if="coverage.cachedAt">{{ tr("usage.coverageCached", { time: formatStamp(coverage.cachedAt) }) }}</span>
        <span v-if="coverage.truncated">{{ tr("usage.truncated") }}</span>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.usage-page {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-8) clamp(var(--space-4), 4vw, var(--space-8));
  background: var(--bg-workspace);
}

.usage-header {
  display: flex;
  max-width: 1100px;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
  margin-inline: auto;
}

.usage-header h1 {
  margin: 0;
  font-family: var(--font-interface-display);
  font-size: calc(24px + var(--font-size-delta));
  line-height: 1.15;
  letter-spacing: -0.025em;
}

.usage-header-meta {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-size-label);
  font-variant-numeric: tabular-nums;
}

.usage-toolbar {
  display: flex;
  max-width: 1100px;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin: var(--space-6) auto 0;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border);
}

.usage-ranges,
.usage-units,
.usage-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.usage-units-label {
  margin-right: var(--space-1);
  color: var(--text-muted);
  font-size: var(--font-size-caption, 11px);
}

.usage-ranges button,
.usage-units button,
.usage-scope,
.usage-action {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-label);
  cursor: pointer;
}

.usage-ranges button:hover,
.usage-units button:hover,
.usage-scope:hover,
.usage-action:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.usage-ranges button[aria-selected="true"],
.usage-units button[aria-pressed="true"],
.usage-scope[aria-pressed="true"] {
  background: var(--bg-active);
  color: var(--text);
}

.usage-action:disabled,
.usage-scope:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.usage-filter {
  display: flex;
  max-width: 1100px;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-3) auto 0;
  color: var(--text-secondary);
  font-size: var(--font-size-label);
}

.usage-filter-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.usage-filter-clear {
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: var(--font-size-label);
  cursor: pointer;
}

.usage-loading,
.usage-empty,
.usage-error {
  display: flex;
  max-width: 1100px;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-8) auto 0;
  color: var(--text-secondary);
}

.usage-empty {
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  padding: var(--space-4);
  border: 1px dashed var(--border);
  border-radius: var(--radius-md);
}

.usage-error {
  color: var(--danger, #d94f4f);
}

.usage-kpis {
  display: grid;
  max-width: 1100px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-3);
  margin: var(--space-4) auto 0;
}

.usage-kpi {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
}

.usage-kpi span {
  color: var(--text-muted);
  font-size: var(--font-size-label);
}

.usage-kpi strong {
  font-size: calc(22px + var(--font-size-delta));
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}

.usage-kpi small {
  color: var(--text-muted);
  font-size: var(--font-size-caption, 11px);
  line-height: 1.4;
}

.usage-panel {
  max-width: 1100px;
  margin: var(--space-4) auto 0;
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
}

.usage-panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}

.usage-panel-head h2 {
  margin: 0;
  font-size: calc(14px + var(--font-size-delta));
  font-weight: 600;
}

.usage-panel-head p {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-size-caption, 11px);
}

.usage-panel-empty {
  margin: var(--space-3) 0 0;
  color: var(--text-muted);
  font-size: var(--font-size-label);
}

.usage-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-3);
  color: var(--text-muted);
  font-size: var(--font-size-caption, 11px);
}

.usage-legend-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.usage-swatch {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.usage-swatch.is-cache,
.usage-chart-segment.is-cache {
  background: color-mix(in srgb, var(--accent) 45%, transparent);
}

.usage-swatch.is-input,
.usage-chart-segment.is-input {
  background: var(--accent);
}

.usage-swatch.is-output,
.usage-chart-segment.is-output {
  background: color-mix(in srgb, var(--accent) 75%, var(--text) 25%);
}

.usage-swatch.is-other,
.usage-chart-segment.is-other {
  background: var(--border-strong, var(--border));
}

.usage-chart {
  display: flex;
  height: 168px;
  align-items: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
  overflow-x: auto;
}

.usage-chart-column {
  display: flex;
  min-width: 18px;
  flex: 1 1 0;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.usage-chart-column:hover .usage-chart-bar,
.usage-chart-column:focus-visible .usage-chart-bar {
  filter: saturate(1.2) brightness(1.03);
}

.usage-chart-column:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.usage-chart-tooltip {
  position: fixed;
  z-index: 200;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  box-shadow: 0 12px 32px rgb(0 0 0 / 18%);
  color: var(--text);
  font-size: var(--font-size-label);
  transform: translate(-50%, -100%);
  pointer-events: none;
}

.usage-chart-tooltip.is-below {
  transform: translate(-50%, 0);
}

.usage-chart-tooltip strong {
  display: block;
  margin-bottom: var(--space-1);
  font-variant-numeric: tabular-nums;
}

.usage-chart-tooltip dl {
  display: grid;
  gap: 2px;
  margin: 0;
}

.usage-chart-tooltip dl > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}

.usage-chart-tooltip dt {
  color: var(--text-muted);
}

.usage-chart-tooltip dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.usage-chart.is-dense .usage-chart-column {
  min-width: 8px;
}

.usage-chart-track {
  display: flex;
  width: 100%;
  height: 132px;
  align-items: flex-end;
}

.usage-chart-bar {
  display: flex;
  width: 100%;
  flex-direction: column;
  overflow: hidden;
  border-radius: 3px 3px 0 0;
  background: var(--bg-app);
}

.usage-chart-segment {
  flex-basis: 0;
}

.usage-chart-label {
  color: var(--text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.usage-chart.is-dense .usage-chart-label {
  visibility: hidden;
}

.usage-table {
  width: 100%;
  margin-top: var(--space-3);
  border-collapse: collapse;
  table-layout: fixed;
  font-size: var(--font-size-label);
}

/* Fixed layout + explicit widths: `max-width: 0` on the name cell (the usual ellipsis trick) made
 * auto layout squeeze the session title to four lines instead of one. */
.usage-table.is-workspaces th:nth-child(1) { width: 46%; }
.usage-table.is-workspaces th:nth-child(2) { width: 18%; }
.usage-table.is-workspaces th:nth-child(3) { width: 14%; }
.usage-table.is-workspaces th:nth-child(4) { width: 12%; }
.usage-table.is-workspaces th:nth-child(5) { width: 10%; }
.usage-table.is-sessions th:nth-child(1) { width: 58%; }
.usage-table.is-sessions th:nth-child(2) { width: 22%; }
.usage-table.is-sessions th:nth-child(3) { width: 20%; }
.usage-table.is-models th:nth-child(1) { width: 52%; }
.usage-table.is-models th:nth-child(2) { width: 26%; }
.usage-table.is-models th:nth-child(3) { width: 22%; }

.usage-table th {
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-weight: 500;
  text-align: left;
}

/* Numeric columns are right-aligned on the data cells; the header must follow, otherwise the label
 * sits at the left edge of a column whose numbers hug the right edge. */
.usage-table th.is-numeric {
  text-align: right;
}

.usage-table th button {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  /* UA stylesheet centres button text; without this the sortable headers stay misaligned. */
  text-align: inherit;
  cursor: pointer;
}

.usage-table th button[aria-pressed="true"] {
  color: var(--text);
}

.usage-table td {
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}

.usage-table tbody tr:last-child td {
  border-bottom: 0;
}

.usage-cell-name {
  min-width: 0;
  overflow: hidden;
}

.usage-cell-number,
.usage-cell-time {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.usage-cell-time {
  overflow: hidden;
  color: var(--text-muted);
  text-overflow: ellipsis;
}

.usage-link {
  display: block;
  max-width: 100%;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.usage-link:hover {
  color: var(--accent);
}

.usage-session-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-session-meta {
  display: block;
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--font-size-caption, 11px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-columns {
  display: grid;
  max-width: 1100px;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--space-4);
  margin-inline: auto;
}

.usage-columns .usage-panel {
  max-width: none;
  margin-inline: 0;
}

.usage-coverage {
  display: flex;
  max-width: 1100px;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: var(--space-4) auto var(--space-8);
  color: var(--text-muted);
  font-size: var(--font-size-caption, 11px);
}
</style>