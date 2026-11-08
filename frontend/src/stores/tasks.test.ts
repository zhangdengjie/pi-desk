import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { TaskDetail, TaskSummary } from "../../bindings/pi-desk/internal/domain";

const listTasks = vi.fn();
const getTask = vi.fn();
const listRunEvents = vi.fn();
const enabled = vi.fn();
const cancelTask = vi.fn();
const retryTask = vi.fn();

vi.mock("../services/tasks", () => ({
  tasksService: {
    enabled: (...args: unknown[]) => enabled(...args),
    listTasks: (...args: unknown[]) => listTasks(...args),
    getTask: (...args: unknown[]) => getTask(...args),
    listRunEvents: (...args: unknown[]) => listRunEvents(...args),
    getRunUsage: vi.fn(),
    cancelTask: (...args: unknown[]) => cancelTask(...args),
    retryTask: (...args: unknown[]) => retryTask(...args),
  },
}));

import { useTasksStore } from "./tasks";

const task: TaskSummary = {
  id: "task_1",
  title: "Inspect me",
  status: "running",
  origin: "chat",
  priority: 0,
  createdAt: 1,
  updatedAt: 2,
};

const detail: TaskDetail = {
  ...task,
  runs: [{
    id: "run_1",
    taskId: task.id,
    runtime: "pi",
    status: "running",
    attempt: 1,
    generation: 1,
    createdAt: 2,
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      estimatedCost: 0,
    },
  }],
};

describe("tasks store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    enabled.mockResolvedValue(true);
    listTasks.mockResolvedValue([task]);
    getTask.mockResolvedValue(detail);
    cancelTask.mockResolvedValue(detail);
    retryTask.mockResolvedValue(detail);
    listRunEvents.mockResolvedValue([{
      id: "evt_1",
      runId: "run_1",
      type: "run.started",
      seq: 1,
      redacted: false,
      truncated: false,
      createdAt: 2,
    }]);
  });

  it("loads tasks, selects the first task, and loads its latest run events", async () => {
    const store = useTasksStore();
    await store.refresh();
    expect(enabled).toHaveBeenCalledOnce();
    expect(store.tasks).toHaveLength(1);
    expect(store.selectedTaskID).toBe("task_1");
    expect(store.detail?.runs).toHaveLength(1);
    expect(store.selectedRunID).toBe("run_1");
    expect(store.events).toHaveLength(1);
    expect(listRunEvents).toHaveBeenCalledWith({ runId: "run_1", afterSeq: 0, limit: 200 });
  });

  it("clears state when the data plane is disabled", async () => {
    enabled.mockResolvedValue(false);
    const store = useTasksStore();
    await store.refresh();
    expect(store.enabled).toBe(false);
    expect(store.tasks).toEqual([]);
    expect(store.detail).toBeNull();
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("cancels and retries the selected task, then refreshes it", async () => {
    const store = useTasksStore();
    await store.refresh();
    await store.cancelSelected();
    expect(cancelTask).toHaveBeenCalledWith({ taskId: "task_1" });
    expect(listTasks).toHaveBeenCalledTimes(2);

    await store.retrySelected();
    expect(retryTask).toHaveBeenCalledWith({ taskId: "task_1" });
    expect(listTasks).toHaveBeenCalledTimes(3);
  });

  it("reloads events when a different run is selected", async () => {
    const store = useTasksStore();
    await store.refresh();
    listRunEvents.mockResolvedValueOnce([]);
    await store.selectRun("run_2");
    expect(listRunEvents).toHaveBeenLastCalledWith({ runId: "run_2", afterSeq: 0, limit: 200 });
  });
});
