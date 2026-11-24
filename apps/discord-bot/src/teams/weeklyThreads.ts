// @effect-diagnostics globalDate:off
/** Watched Teams group chats open a fresh log thread each week, starting Monday 00:00 here. */
export const TEAMS_THREAD_WEEK_TIME_ZONE = "Europe/Amsterdam";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** `week-YYYY-MM-DD`, naming the Monday that starts the week containing `at`. */
export function teamsWeekBucket(at: Date, timeZone: string = TEAMS_THREAD_WEEK_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const daysSinceMonday = Math.max(
    WEEKDAYS.indexOf(part("weekday") as (typeof WEEKDAYS)[number]),
    0,
  );
  const monday = new Date(
    Date.UTC(
      Number(part("year")),
      Number(part("month")) - 1,
      Number(part("day")) - daysSinceMonday,
    ),
  );
  return `week-${monday.toISOString().slice(0, 10)}`;
}

/** Appends the week bucket to a group chat's key. */
export function weeklyThreadKey(locationKey: string, at: Date): string {
  return `${locationKey}/${teamsWeekBucket(at)}`;
}
