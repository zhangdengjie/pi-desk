import { DeleteSchedule, Enabled, ListSchedules, SaveSchedule } from "../../bindings/pi-desk/internal/appservice/scheduleservice";
import type { ScheduleIDRequest, ScheduleSaveRequest, ScheduleSummary } from "../../bindings/pi-desk/internal/domain";

export const scheduleService = {
  enabled: (): Promise<boolean> => Enabled(),
  list: (): Promise<ScheduleSummary[] | null> => ListSchedules(),
  save: (request: ScheduleSaveRequest): Promise<ScheduleSummary> => SaveSchedule(request),
  delete: (request: ScheduleIDRequest): Promise<void> => DeleteSchedule(request),
};
