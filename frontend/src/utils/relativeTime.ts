import { tr } from "../i18n";

/**
 * The sidebar's relative timestamp ("19小时", "2天"), extracted so the quick switcher can show the
 * same wording instead of growing a second copy that drifts. `now` is passed in because the sidebar
 * re-renders these on a one-minute ticker and the palette renders them at open time.
 */
export function relativeTimeText(value: string | undefined, now: number): string {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return tr("sidebar.justNow");
  if (minutes < 60) return tr("sidebar.relativeMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tr("sidebar.relativeHours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return tr("sidebar.relativeDays", { count: days });
  const months = Math.floor(days / 30);
  if (months < 12) return tr("sidebar.relativeMonths", { count: months });
  return tr("sidebar.relativeYears", { count: Math.floor(months / 12) });
}