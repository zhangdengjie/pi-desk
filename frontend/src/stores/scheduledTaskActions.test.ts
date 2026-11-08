import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleSummary } from "../../bindings/pi-desk/internal/domain";
import { loadGoSchedules, saveScheduledTaskGo } from "./scheduledTaskActions";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
  runNow: vi.fn(),
  adoptThread: vi.fn(),
}));

vi.mock("../services/schedules", () => ({
  scheduleService: { list: mocks.list, save: mocks.save, delete: mocks.delete, runNow: mocks.runNow },
}));
vi.mock("../services/tasks", () => ({
  tasksService: { adoptThread: mocks.adoptThread },
}));
vi.mock("../services/agent", () => ({ agentService: {}, onPiEvent: () => () => undefined }));

function fakeStore() {
  return {
    bootstrap: { r2Scheduler: true },
    workspaces: [{ id: "workspace-1", name: "repo", path: "/tmp/repo", trust: "approve", kind: "local" }],
    scheduledTasks: [],
    threads: [],
    messagesByThread: {},
    draftsByThread: {},
    transcriptEntriesByThread: {},
    transcriptStateByThread: {},
    scheduledTaskRunningByID: {},
    applyWorkspaceDefaultModel: vi.fn(),
    persistDesktopState: vi.fn().mockResolvedValue(undefined),
    removeThreadState: vi.fn(),
    scheduleDesktopStateSave: vi.fn(),
  };
}

function summary(): ScheduleSummary {
  return {
    id: "schedule-1", taskId: "task-1", name: "Nightly", prompt: "run",
    workspaceId: "workspace-1", modelProvider: "openai", modelId: "gpt-5",
    modelName: "GPT", thinkingLevel: "high", frequency: "daily", time: "09:00",
    timezone: "UTC", enabled: true, catchUp: true,
    nextRunAt: "2026-11-10T09:00:00Z", lastThreadId: "thread-1",
    createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z",
  };
}

describe("Go schedule actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([]);
    mocks.save.mockResolvedValue(summary());
    mocks.adoptThread.mockResolvedValue({ id: "task-1" });
  });

  it("loads Go schedules with their Task binding", async () => {
    mocks.list.mockResolvedValue([summary()]);
    const store = fakeStore();
    await loadGoSchedules(store as never);
    expect(store.scheduledTasks).toHaveLength(1);
    expect(store.scheduledTasks[0]).toMatchObject({
      id: "schedule-1", taskId: "task-1", lastThreadId: "thread-1", enabled: true, lastStatus: undefined,
    });
  });

  it("creates a placeholder thread and adopts it before saving", async () => {
    const store = fakeStore();
    const id = await saveScheduledTaskGo(store as never, {
      name: "Nightly", prompt: "run", workspaceId: "workspace-1",
      modelProvider: "openai", modelId: "gpt-5", modelName: "GPT", thinkingLevel: "high",
      frequency: "daily", time: "09:00", weekday: 1, runAt: "",
    });
    expect(id).toBe("schedule-1");
    expect(store.persistDesktopState).toHaveBeenCalled();
    expect(mocks.adoptThread).toHaveBeenCalledTimes(1);
    expect(store.threads).toHaveLength(1);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      lastThreadId: expect.any(String),
      workspaceId: "workspace-1",
      enabled: true,
      nextRunAt: expect.any(String),
    }));
    expect(store.scheduleDesktopStateSave).toHaveBeenCalled();
  });
});
