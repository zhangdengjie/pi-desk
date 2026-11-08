import {
  AdoptThread,
  ArchiveTask,
  CancelTask,
  Enabled,
  GetRunUsage,
  GetTask,
  ListArchivedTasks,
  ListRunEvents,
  ListTasks,
  RetryTask,
  UnarchiveTask,
} from "../../bindings/pi-desk/internal/appservice/taskservice";
import type {
  TaskDetail,
  TaskEventView,
  TaskEventsRequest,
  TaskRequest,
  TaskRunRequest,
  TaskSummary,
  TaskUsageSummary,
} from "../../bindings/pi-desk/internal/domain";

export const tasksService = {
  enabled: (): Promise<boolean> => Enabled(),
  listTasks: (): Promise<TaskSummary[] | null> => ListTasks(),
  listArchivedTasks: (): Promise<TaskSummary[] | null> => ListArchivedTasks(),
  adoptThread: (threadId: string): Promise<TaskDetail> => AdoptThread({ threadId }),
  getTask: (request: TaskRequest): Promise<TaskDetail> => GetTask(request),
  listRunEvents: (request: TaskEventsRequest): Promise<TaskEventView[] | null> => ListRunEvents(request),
  getRunUsage: (request: TaskRunRequest): Promise<TaskUsageSummary> => GetRunUsage(request),
  cancelTask: (request: TaskRequest): Promise<TaskDetail> => CancelTask(request),
  retryTask: (request: TaskRequest): Promise<TaskDetail> => RetryTask(request),
  archiveTask: (request: TaskRequest): Promise<TaskDetail> => ArchiveTask(request),
  unarchiveTask: (request: TaskRequest): Promise<TaskDetail> => UnarchiveTask(request),
};
