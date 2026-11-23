// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodePath from "node:path";

import { readGroupChatMirror, rememberGroupChatMirror } from "./groupChats.ts";

/**
 * A channel reply chain keeps its own T3 thread; a new top-level post joins the channel's thread
 * for the week. Group chats roll over weekly. Weeks start Monday 00:00 in this time zone.
 */
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

/** Appends the week bucket to a location key. */
export function weeklyThreadKey(locationKey: string, at: Date): string {
  return `${locationKey}/${teamsWeekBucket(at)}`;
}

/** Key of a Teams channel, shared by every reply chain posted in it. */
export function teamsChannelLocationKey(input: {
  readonly tenantId: string;
  readonly teamId: string;
  readonly channelId: string;
}): string {
  return `native/${input.tenantId}/${input.teamId}/${input.channelId}`;
}

export function weeklyThreadsFile(dataDir: string): string {
  return NodePath.join(dataDir, "teams-weekly-threads.json");
}

/** The T3 thread opened for a channel week, if any. */
export function readWeeklyThread(filePath: string, weekKey: string): string | null {
  return readGroupChatMirror(filePath, weekKey);
}

export function rememberWeeklyThread(
  filePath: string,
  weekKey: string,
  t3ThreadId: string,
): Promise<void> {
  return rememberGroupChatMirror(filePath, weekKey, t3ThreadId);
}

export interface ChannelWeek {
  readonly file: string;
  readonly weekKey: string;
  /** This week's thread for the channel, for a reply chain that has no link yet. */
  readonly joinT3ThreadId: string | undefined;
}

/** Weekly thread for a channel message; `null` outside channels (personal and group chats). */
export function channelWeek(input: {
  readonly dataDir: string;
  readonly tenantId: string;
  readonly teamId: string | undefined;
  readonly channelId: string | undefined;
  readonly at: Date;
}): ChannelWeek | null {
  if (!input.teamId || !input.channelId) return null;
  const file = weeklyThreadsFile(input.dataDir);
  const weekKey = weeklyThreadKey(
    teamsChannelLocationKey({
      tenantId: input.tenantId,
      teamId: input.teamId,
      channelId: input.channelId,
    }),
    input.at,
  );
  return { file, weekKey, joinT3ThreadId: readWeeklyThread(file, weekKey) ?? undefined };
}

/** Records a thread a channel reply chain just opened as that channel's thread for the week. */
export async function rememberChannelWeek(
  week: ChannelWeek | null,
  turn: { readonly threadId: string; readonly isNew: boolean },
): Promise<void> {
  if (week === null || !turn.isNew || readWeeklyThread(week.file, week.weekKey) !== null) return;
  await rememberWeeklyThread(week.file, week.weekKey, turn.threadId);
}
