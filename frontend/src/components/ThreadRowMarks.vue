<script setup lang="ts">
/**
 * The status tail (or head) of a session row, in one place.
 *
 * Why a component: the same row markup is rendered twice - inside a workspace group and inside the
 * cross-project 活跃会话 list - and the four states used to be two `v-if`s written out inline, so the
 * second list would have had to re-derive them. Three of the four states had no marker at all, which
 * is what made the single dot that did exist unreadable: it meant "unread output", not "this session
 * is active".
 *
 * Signal axes, deliberately separate so two markers can sit side by side without lying:
 *   - `thread-status`  spinner  -> the model is producing output / Pi is starting (v-spin, never CSS)
 *   - `thread-mark`    amber    -> `attention`: Pi exited or the session errored, it needs you
 *   - `thread-mark`    green    -> `live`: the Pi process is alive and idle, i.e. what 激活 means
 *   - `thread-unread`  blue     -> output arrived while the session was not in view
 *
 * Geometry and colours live in layout.css / workbench.css. Nothing here carries a Tailwind utility:
 * tailwind.css imports with `important`, so a `bg-[var(--text)]` on the unread dot silently beat the
 * `background: var(--blue)` rule and made 未读 look like a selection marker (the bug this file closes).
 */
import { computed } from "vue";
import { tr } from "../i18n";
import type { ThreadStatus } from "../stores/app";
import { vSpin } from "../utils/spin";

type MarkedThread = { status: ThreadStatus; started: boolean; unread?: boolean };

const props = defineProps<{ thread: MarkedThread }>();

const busy = computed(() => props.thread.status === "running" || props.thread.status === "starting");
/** Nothing while the spinner speaks: a running session cannot also be "waiting for you". */
const mark = computed<"" | "attention" | "live">(() => {
  if (busy.value) return "";
  if (props.thread.status === "attention") return "attention";
  return props.thread.started ? "live" : "";
});
const markLabel = computed(() => (mark.value === "attention" ? tr("sidebar.needsAttention") : tr("sidebar.piIdle")));
const unreadLabel = computed(() => tr("sidebar.unread"));
const busyLabel = computed(() => (props.thread.status === "starting" ? tr("sidebar.piStarting") : tr("sidebar.taskRunning")));
</script>

<template>
  <span class="thread-marks">
    <span v-if="mark" role="img" class="thread-mark" :data-state="mark" :title="markLabel" :aria-label="markLabel" />
    <span v-if="thread.unread && !busy" role="img" class="thread-unread" :title="unreadLabel" :aria-label="unreadLabel" />
    <span v-if="busy" v-spin role="img" class="thread-status" :data-state="thread.status" :title="busyLabel" :aria-label="busyLabel" />
  </span>
</template>
