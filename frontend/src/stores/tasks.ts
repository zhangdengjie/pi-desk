import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { TaskDetail, TaskEventView, TaskRunSummary, TaskSummary } from "../../bindings/pi-desk/internal/domain";
import { tasksService } from "../services/tasks";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export type TaskView = "active" | "archived";

export const useTasksStore = defineStore("tasks", () => {
  const enabled = ref(false);
  const view = ref<TaskView>("active");
  const tasks = ref<TaskSummary[]>([]);
  const selectedTaskID = ref("");
  const detail = ref<TaskDetail | null>(null);
  const selectedRunID = ref("");
  const events = ref<TaskEventView[]>([]);
  const loading = ref(false);
  const eventsLoading = ref(false);
  const actionLoading = ref(false);
  const actionError = ref("");
  const error = ref("");

  const selectedTask = computed(() => tasks.value.find((task) => task.id === selectedTaskID.value) ?? null);
  const selectedRun = computed<TaskRunSummary | null>(() => {
    const runs = detail.value?.runs ?? [];
    return runs.find((run) => run.id === selectedRunID.value) ?? null;
  });

  function clearDetail() {
    detail.value = null;
    selectedRunID.value = "";
    events.value = [];
  }

  async function refreshEvents() {
    if (!selectedRunID.value) {
      events.value = [];
      return;
    }
    eventsLoading.value = true;
    try {
      events.value = (await tasksService.listRunEvents({ runId: selectedRunID.value, afterSeq: 0, limit: 200 })) ?? [];
    } catch (cause) {
      error.value = errorMessage(cause);
      events.value = [];
    } finally {
      eventsLoading.value = false;
    }
  }

  async function select(taskID: string) {
    if (!taskID) {
      selectedTaskID.value = "";
      clearDetail();
      return;
    }
    selectedTaskID.value = taskID;
    error.value = "";
    try {
      detail.value = await tasksService.getTask({ taskId: taskID });
      const runs = detail.value?.runs ?? [];
      selectedRunID.value = runs.length ? runs[runs.length - 1].id : "";
      await refreshEvents();
    } catch (cause) {
      error.value = errorMessage(cause);
      clearDetail();
    }
  }

  async function selectRun(runID: string) {
    selectedRunID.value = runID;
    await refreshEvents();
  }

  async function runAction(action: "cancel" | "retry" | "archive" | "unarchive") {
    if (!selectedTaskID.value || actionLoading.value) return;
    actionLoading.value = true;
    actionError.value = "";
    try {
      const request = { taskId: selectedTaskID.value };
      if (action === "cancel") await tasksService.cancelTask(request);
      else if (action === "retry") await tasksService.retryTask(request);
      else if (action === "archive") await tasksService.archiveTask(request);
      else await tasksService.unarchiveTask(request);
      await refresh();
    } catch (cause) {
      actionError.value = errorMessage(cause);
    } finally {
      actionLoading.value = false;
    }
  }

  async function cancelSelected() {
    await runAction("cancel");
  }

  async function retrySelected() {
    await runAction("retry");
  }

  async function archiveSelected() {
    await runAction("archive");
  }

  async function unarchiveSelected() {
    await runAction("unarchive");
  }

  async function setView(next: TaskView) {
    if (view.value === next) return;
    view.value = next;
    selectedTaskID.value = "";
    clearDetail();
    await refresh();
  }

  async function refresh() {
    loading.value = true;
    error.value = "";
    try {
      enabled.value = await tasksService.enabled();
      if (!enabled.value) {
        tasks.value = [];
        selectedTaskID.value = "";
        clearDetail();
        return;
      }
      tasks.value = (view.value === "archived" ? await tasksService.listArchivedTasks() : await tasksService.listTasks()) ?? [];
      const stillPresent = tasks.value.some((task) => task.id === selectedTaskID.value);
      if (!stillPresent) {
        selectedTaskID.value = tasks.value.length ? tasks.value[0].id : "";
      }
      if (selectedTaskID.value) {
        await select(selectedTaskID.value);
      } else {
        clearDetail();
      }
    } catch (cause) {
      error.value = errorMessage(cause);
    } finally {
      loading.value = false;
    }
  }

  return {
    enabled,
    view,
    tasks,
    selectedTaskID,
    detail,
    selectedRunID,
    events,
    loading,
    eventsLoading,
    actionLoading,
    actionError,
    error,
    selectedTask,
    selectedRun,
    refresh,
    select,
    selectRun,
    refreshEvents,
    cancelSelected,
    retrySelected,
    archiveSelected,
    unarchiveSelected,
    setView,
  };
});
