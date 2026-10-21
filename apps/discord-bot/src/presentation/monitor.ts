import { formatThreadTitle } from "./messages.ts";
import { discordMessageLooksLikeSentry, type SentryDiscordMessageInput } from "./sentryLinks.ts";

/**
 * Channel-topic tag. A project channel whose topic contains this token turns
 * each Sentry post into a thread and an investigation.
 */
export const MONITOR_TOPIC_TAG = "omegent-monitor";

/**
 * First-turn request for a Sentry post in a monitor channel. The thread starter
 * is the alert. The reply's first severity line decides the follow-up.
 */
export const SENTRY_MONITOR_PROMPT = [
  "A Sentry alert was posted in this monitor channel. The alert is the Discord thread starter. Investigate it in this repository.",
  "",
  "The first line of your reply must be exactly one of:",
  "severity: bug",
  "severity: transient",
  "",
  "bug: a defect to fix here. Investigate, prepare the fix, and open a pull request. Do not mention @everyone.",
  "transient: noise, a blip, or already recovering. Do not change code. Explain why, and mention @everyone.",
].join("\n");

function normalizeTopicToken(token: string): string {
  return token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/giu, "").toLowerCase();
}

/** True when a channel topic includes the monitor tag as its own token. */
export function topicRequestsMonitor(topic: string | null | undefined): boolean {
  if (topic === null || topic === undefined || topic.length === 0) return false;
  return topic.split(/\s+/u).some((token) => normalizeTopicToken(token) === MONITOR_TOPIC_TAG);
}

/**
 * A Sentry app or webhook post, not a person pasting a link and not this bot.
 * The channel topic is checked separately.
 */
export function isSentryMonitorPost(input: {
  readonly authorId?: string | null | undefined;
  readonly authorBot?: boolean | undefined;
  readonly webhookId?: string | null | undefined;
  readonly botUserId: string;
  readonly message: SentryDiscordMessageInput;
}): boolean {
  if (
    input.authorId !== undefined &&
    input.authorId !== null &&
    input.authorId === input.botUserId
  ) {
    return false;
  }
  const webhook = typeof input.webhookId === "string" && input.webhookId.length > 0;
  if (input.authorBot !== true && !webhook) return false;
  return discordMessageLooksLikeSentry(input.message);
}

/** Discord thread name from the Sentry embed title. */
export function sentryMonitorThreadTitle(message: SentryDiscordMessageInput): string {
  const embedTitle = message.embeds?.find((embed) => (embed.title?.trim().length ?? 0) > 0)?.title;
  return formatThreadTitle(embedTitle ?? "", 100, "Sentry alert");
}

const SEVERITY_LINE = /^[ \t>*_-]*severity:[ \t>*_-]*(transient|bug)\b/imu;

/** First `severity:` line in an answer, if it names transient or bug. */
export function monitorSeverity(text: string): "transient" | "bug" | null {
  const match = SEVERITY_LINE.exec(text);
  if (match?.[1] === "transient" || match?.[1] === "bug") return match[1];
  return null;
}

/**
 * On a monitor channel, a transient classification must ping @everyone.
 * Other topics and bug classifications are left unchanged.
 */
export function applyMonitorEveryoneMention(
  text: string,
  topic: string | null | undefined,
): string {
  if (!topicRequestsMonitor(topic)) return text;
  if (monitorSeverity(text) !== "transient") return text;
  if (/@everyone\b/u.test(text)) return text;
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return "@everyone";
  return `${trimmed}\n\n@everyone`;
}
