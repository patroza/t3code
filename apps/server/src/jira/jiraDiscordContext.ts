// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off
/**
 * Minimal Discord post helper for untrusted Jira context notes.
 * Intentionally small — does not depend on MCP tools or the full Discord bot.
 */
import * as NodeFSP from "node:fs/promises";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_DEFAULT_ENV_FILE = "/run/secrets/discord-bot.env";

function extractEnvAssignment(raw: string, key: string): string | undefined {
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith(`${key}=`)) continue;
    const value = line.slice(key.length + 1).trim();
    if (value.length === 0) return undefined;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

export async function resolveDiscordBotToken(): Promise<string | null> {
  const fromEnv = process.env.DISCORD_BOT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const envFile = await NodeFSP.readFile(DISCORD_DEFAULT_ENV_FILE, "utf8");
    const fromFile = extractEnvAssignment(envFile, "DISCORD_BOT_TOKEN")?.trim();
    return fromFile && fromFile.length > 0 ? fromFile : null;
  } catch {
    return null;
  }
}

/** Discord message body length limit (UTF-16 code units; we treat as chars). */
const DISCORD_CONTENT_MAX = 2000;

export function formatDiscordJiraContextNote(input: {
  readonly issueKey: string;
  readonly requester: string;
  readonly prompt: string;
  readonly commentUrl?: string | null;
}): string {
  const header = `**Jira context** (no agent run) · \`${input.issueKey}\` · ${input.requester}`;
  const link = input.commentUrl ? `\n${input.commentUrl}` : "";
  const body = input.prompt.trim();
  const combined = `${header}${link}\n\n${body}`;
  if (combined.length <= DISCORD_CONTENT_MAX) return combined;
  const budget = DISCORD_CONTENT_MAX - header.length - link.length - 20;
  const clipped = body.slice(0, Math.max(0, budget));
  return `${header}${link}\n\n${clipped}\n…(truncated)`;
}

export async function postDiscordChannelMessage(input: {
  readonly token: string;
  readonly channelId: string;
  readonly content: string;
}): Promise<{ readonly id: string; readonly channelId: string }> {
  const url = `${DISCORD_API_BASE_URL}/channels/${input.channelId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bot ${input.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: input.content,
      allowed_mentions: { parse: [] as string[] },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord create message failed (${response.status}): ${body}`);
  }
  const json = (await response.json()) as { id?: string; channel_id?: string };
  return {
    id: json.id ?? "",
    channelId: json.channel_id ?? input.channelId,
  };
}
