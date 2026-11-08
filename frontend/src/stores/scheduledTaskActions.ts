import { agentService } from "../services/agent";
import { tr } from "../i18n";
import { createID } from "../utils/ids";
import {
  localDateTimeToISO,
  nextScheduledRun,
  scheduledTaskThinkingLevels,
  type ScheduledTask,
  type ScheduledTaskDraft,
} from "../utils/scheduledTasks";
import type { useAppStore } from "./app";
import type { PiModel, ThreadSummary } from "./app";

type AppStore = ReturnType<typeof useAppStore>;

const scheduledTaskStoppingThreads = new Set<string>();
let scheduledTaskTimer: ReturnType<typeof setInterval> | undefined;
let scheduledTaskTicking = false;

export function markScheduledTaskStopping(threadId: string) {
  scheduledTaskStoppingThreads.add(threadId);
}

export function clearScheduledTaskStopping(threadId: string) {
  scheduledTaskStoppingThreads.delete(threadId);
}

export function isScheduledTaskStopping(threadId: string): boolean {
  return scheduledTaskStoppingThreads.has(threadId);
}

function nowISO(): string {
  return new Date().toISOString();
}

function modelKey(model: Pick<PiModel, "provider" | "id">): string {
  return `${model.provider}\u0000${model.id}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startScheduledTaskScheduler(store: AppStore) {
  if (scheduledTaskTimer) return;
  scheduledTaskTimer = setInterval(() => void checkScheduledTasks(store), 30_000);
}

export function stopScheduledTaskScheduler() {
  if (!scheduledTaskTimer) return;
  clearInterval(scheduledTaskTimer);
  scheduledTaskTimer = undefined;
}

export function saveScheduledTask(store: AppStore, draft: ScheduledTaskDraft, taskID = ""): ScheduledTask {
  const workspace = store.workspaces.find((item) => item.id === draft.workspaceId);
  if (!workspace || workspace.kind === "ssh" || workspace.trust !== "approve") {
    throw new Error(tr("scheduledTasks.errors.workspace"));
  }
  const name = draft.name.trim();
  const prompt = draft.prompt.trim();
  if (!name || !prompt) throw new Error(tr("scheduledTasks.errors.required"));
  const modelProvider = draft.modelProvider.trim();
  const modelId = draft.modelId.trim();
  if (!modelProvider || !modelId) throw new Error(tr("scheduledTasks.errors.model"));
  const thinkingLevel = draft.thinkingLevel.trim();
  if (!scheduledTaskThinkingLevels.includes(thinkingLevel as (typeof scheduledTaskThinkingLevels)[number])) {
    throw new Error(tr("scheduledTasks.errors.thinkingLevel"));
  }
  const now = nowISO();
  const existing = store.scheduledTasks.find((task) => task.id === taskID);
  const schedule = {
    frequency: draft.frequency,
    time: draft.frequency === "once" ? undefined : draft.time,
    weekday: draft.frequency === "weekly" ? draft.weekday : undefined,
    runAt: draft.frequency === "once" ? localDateTimeToISO(draft.runAt) : undefined,
  } as const;
  const nextRunAt = nextScheduledRun(schedule);
  if (!nextRunAt) throw new Error(tr("scheduledTasks.errors.future"));
  const task: ScheduledTask = {
    ...(existing ?? {
      id: createID("schedule"),
      enabled: true,
      createdAt: now,
    }),
    ...schedule,
    name,
    prompt,
    workspaceId: workspace.id,
    modelProvider,
    modelId,
    modelName: draft.modelName.trim() || undefined,
    thinkingLevel,
    nextRunAt,
    updatedAt: now,
  };
  if (existing) Object.assign(existing, task);
  else store.scheduledTasks.unshift(task);
  store.scheduleDesktopStateSave();
  return task;
}

export function deleteScheduledTask(store: AppStore, taskID: string): ScheduledTask | undefined {
  const index = store.scheduledTasks.findIndex((task) => task.id === taskID);
  if (index < 0) return undefined;
  const [removed] = store.scheduledTasks.splice(index, 1);
  store.scheduleDesktopStateSave();
  return removed;
}

export function restoreScheduledTask(store: AppStore, task: ScheduledTask) {
  if (store.scheduledTasks.some((item) => item.id === task.id)) return;
  store.scheduledTasks.unshift({
    ...task,
    enabled: Boolean(task.enabled && task.modelProvider && task.modelId && task.thinkingLevel),
    updatedAt: nowISO(),
  });
  store.scheduleDesktopStateSave();
}

export function toggleScheduledTask(store: AppStore, taskID: string) {
  const task = store.scheduledTasks.find((item) => item.id === taskID);
  if (!task) return;
  if (!task.enabled && (!task.modelProvider || !task.modelId || !task.thinkingLevel)) return;
  task.enabled = !task.enabled;
  task.updatedAt = nowISO();
  task.nextRunAt = task.enabled ? nextScheduledRun(task) : undefined;
  if (task.enabled && !task.nextRunAt) task.enabled = false;
  store.scheduleDesktopStateSave();
}

export function finishScheduledRun(store: AppStore, threadId: string, status: "completed" | "failed" | "cancelled", error = "") {
  for (const task of store.scheduledTasks) {
    if (task.lastThreadId !== threadId || task.lastStatus !== "started") continue;
    task.lastStatus = status;
    task.lastError = status === "failed"
      ? error || store.messagesByThread[threadId]?.findLast(message => message.role === "assistant")?.error || store.threads.find(thread => thread.id === threadId)?.error
      : undefined;
    task.updatedAt = nowISO();
  }
  store.scheduleDesktopStateSave();
}

export async function runScheduledTask(store: AppStore, taskID: string, manual = true): Promise<string | undefined> {
  const task = store.scheduledTasks.find((item) => item.id === taskID);
  if (!task || store.scheduledTaskRunningByID[taskID] || task.lastStatus === "started") return undefined;
  store.scheduledTaskRunningByID[taskID] = true;
  const startedAt = nowISO();
  let threadID: string | undefined;
  try {
    const workspace = store.workspaces.find((item) => item.id === task.workspaceId);
    if (!workspace || workspace.kind === "ssh" || workspace.trust !== "approve") {
      throw new Error(tr("scheduledTasks.errors.workspace"));
    }
    if (!task.modelProvider || !task.modelId) throw new Error(tr("scheduledTasks.errors.model"));
    if (!task.thinkingLevel) throw new Error(tr("scheduledTasks.errors.thinkingLevel"));
    threadID = createID("thread");
    const thread: ThreadSummary = {
      id: threadID,
      title: task.name,
      workspace: workspace.name,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      trust: "approve",
      status: "idle",
      started: false,
      generation: 0,
      createdAt: startedAt,
      modifiedAt: startedAt,
      unread: true,
    };
    store.threads.unshift(thread);
    store.messagesByThread[threadID] = [];
    store.draftsByThread[threadID] = "";
    store.transcriptEntriesByThread[threadID] = [];
    store.transcriptStateByThread[threadID] = "loaded";
    const scheduledModel: PiModel = { provider: task.modelProvider, id: task.modelId, name: task.modelName };
    store.pendingModelByThread[threadID] = scheduledModel;
    store.sessionStateByThread[threadID] = { model: scheduledModel };
    await store.ensureSession(thread);
    const appliedModel = store.sessionStateByThread[threadID]?.model;
    if (!appliedModel || modelKey(appliedModel) !== modelKey(scheduledModel)) {
      throw new Error(thread.error || tr("scheduledTasks.errors.modelApply"));
    }
    const availableThinkingLevels = store.thinkingLevelsByThread[threadID] ?? [];
    if (!availableThinkingLevels.includes(task.thinkingLevel)) {
      throw new Error(tr("scheduledTasks.errors.thinkingLevelUnavailable", { level: task.thinkingLevel }));
    }
    await agentService.setThinkingLevel({ threadId: threadID, level: task.thinkingLevel });
    await store.refreshState(threadID);
    if (store.sessionStateByThread[threadID]?.thinkingLevel !== task.thinkingLevel) {
      throw new Error(tr("scheduledTasks.errors.thinkingLevelApply"));
    }
    task.lastThreadId = threadID;
    task.lastStatus = "started";
    task.lastError = undefined;
    store.scheduleDesktopStateSave();
    const delivered = await store.deliverPrompt(thread, task.prompt, []);
    if (!delivered) throw new Error(thread.error || tr("scheduledTasks.errors.start"));
    return threadID;
  } catch (error) {
    const failure = errorMessage(error);
    task.lastStatus = "failed";
    task.lastError = failure;
    task.lastThreadId = threadID;
    if (threadID) {
      const failedThread = store.threads.find((candidate) => candidate.id === threadID);
      if (failedThread) {
        if (failedThread.started) {
          failedThread.status = "attention";
          failedThread.error = failure;
        } else {
          store.removeThreadState(threadID);
        }
      }
    }
    return undefined;
  } finally {
    task.lastRunAt = startedAt;
    task.updatedAt = nowISO();
    if (!manual) {
      task.nextRunAt = task.frequency === "once" ? undefined : nextScheduledRun(task);
      if (task.frequency === "once") task.enabled = false;
    }
    store.scheduledTaskRunningByID[taskID] = false;
    store.scheduleDesktopStateSave();
  }
}

export async function checkScheduledTasks(store: AppStore, now = new Date()) {
  if (scheduledTaskTicking || !store.catalogReady) return;
  scheduledTaskTicking = true;
  try {
    const due = store.scheduledTasks.filter((task) => task.enabled && task.nextRunAt && Date.parse(task.nextRunAt) <= now.getTime());
    for (const task of due) await runScheduledTask(store, task.id, false);
  } finally {
    scheduledTaskTicking = false;
  }
}
