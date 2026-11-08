import { DeleteSchedule, Enabled, ListSchedules, RunNow, SaveSchedule } from "../../bindings/pi-desk/internal/appservice/scheduleservice";
import type { ScheduleIDRequest, ScheduleRunResult, ScheduleSaveRequest, ScheduleSummary } from "../../bindings/pi-desk/internal/domain";

export const scheduleService = {
  enabled: (): Promise<boolean> => Enabled(),
  list: (): Promise<ScheduleSummary[] | null> => ListSchedules(),
  save: (request: ScheduleSaveRequest): Promise<ScheduleSummary> => SaveSchedule(request),
  delete: (request: ScheduleIDRequest): Promise<void> => DeleteSchedule(request),
  runNow: (request: ScheduleIDRequest): Promise<ScheduleRunResult> => RunNow(request),
};
