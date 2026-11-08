import {
  CancelTask,
  Enabled,
  GetRunUsage,
  GetTask,
  ListRunEvents,
  ListTasks,
  RetryTask,
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
  getTask: (request: TaskRequest): Promise<TaskDetail> => GetTask(request),
  listRunEvents: (request: TaskEventsRequest): Promise<TaskEventView[] | null> => ListRunEvents(request),
  getRunUsage: (request: TaskRunRequest): Promise<TaskUsageSummary> => GetRunUsage(request),
  cancelTask: (request: TaskRequest): Promise<TaskDetail> => CancelTask(request),
  retryTask: (request: TaskRequest): Promise<TaskDetail> => RetryTask(request),
};
