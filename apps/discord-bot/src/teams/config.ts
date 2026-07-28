// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off tryCatchInEffectGen:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expandHomePath } from "../projectAliases.ts";

export interface TeamsChannelConfig {
  readonly teamId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly projectShortName: string;
  readonly discordChannelId?: string | undefined;
  /**
   * discord: mirror into a Discord thread (legacy compatibility).
   * t3-only: start T3 directly and acknowledge through the optional Teams workflow webhook.
   * native: native Teams activities own replies; Graph polling only supplies ambient triggers.
   */
  readonly deliveryMode?: "discord" | "t3-only" | "native" | undefined;
  readonly company: string;
  readonly environment: string;
  readonly companyKeywords: ReadonlyArray<string>;
  readonly environmentKeywords: ReadonlyArray<string>;
  readonly problemKeywords?: ReadonlyArray<string> | undefined;
  readonly automaticAssessmentEnabled?: boolean | undefined;
  readonly internalUserIds?: ReadonlyArray<string> | undefined;
  readonly reactionTriggerTypes?: ReadonlyArray<string> | undefined;
  readonly messageTagTriggers?: ReadonlyArray<string> | undefined;
  readonly respondToMentions?: boolean | undefined;
  readonly teamsIncomingWebhookUrl?: string | undefined;
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isChannelConfig(value: unknown): value is TeamsChannelConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.teamId === "string" &&
    typeof candidate.channelId === "string" &&
    typeof candidate.channelName === "string" &&
    typeof candidate.projectShortName === "string" &&
    (candidate.discordChannelId === undefined || typeof candidate.discordChannelId === "string") &&
    (candidate.deliveryMode === undefined ||
      candidate.deliveryMode === "discord" ||
      candidate.deliveryMode === "t3-only" ||
      candidate.deliveryMode === "native") &&
    typeof candidate.company === "string" &&
    typeof candidate.environment === "string" &&
    isStringArray(candidate.companyKeywords) &&
    isStringArray(candidate.environmentKeywords) &&
    (candidate.problemKeywords === undefined || isStringArray(candidate.problemKeywords)) &&
    (candidate.automaticAssessmentEnabled === undefined ||
      typeof candidate.automaticAssessmentEnabled === "boolean") &&
    (candidate.internalUserIds === undefined || isStringArray(candidate.internalUserIds)) &&
    (candidate.reactionTriggerTypes === undefined ||
      isStringArray(candidate.reactionTriggerTypes)) &&
    (candidate.messageTagTriggers === undefined || isStringArray(candidate.messageTagTriggers)) &&
    (candidate.respondToMentions === undefined ||
      typeof candidate.respondToMentions === "boolean") &&
    (candidate.teamsIncomingWebhookUrl === undefined ||
      typeof candidate.teamsIncomingWebhookUrl === "string")
  );
}

export function loadTeamsChannelConfigsFromFileSync(
  filePath: string,
): ReadonlyArray<TeamsChannelConfig> {
  const resolvedPath = NodePath.resolve(expandHomePath(filePath.trim()));
  const raw = NodeFS.readFileSync(resolvedPath, "utf8").trim();
  if (raw.length === 0) return [];

  const parsed = JSON.parse(raw) as unknown;
  const channels = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" &&
        parsed !== null &&
        "channels" in parsed &&
        Array.isArray((parsed as { channels?: unknown }).channels)
      ? (parsed as { channels: ReadonlyArray<unknown> }).channels
      : null;
  if (channels === null || !channels.every(isChannelConfig)) {
    throw new Error("Teams channel config file must be an array of valid channel objects.");
  }

  return channels.map((channel) => ({
    ...channel,
    deliveryMode:
      channel.deliveryMode ?? (channel.discordChannelId === undefined ? "t3-only" : "discord"),
    projectShortName: channel.projectShortName.trim().toLowerCase(),
    companyKeywords: channel.companyKeywords.map((value: string) => value.trim()).filter(Boolean),
    environmentKeywords: channel.environmentKeywords
      .map((value: string) => value.trim())
      .filter(Boolean),
    ...(channel.problemKeywords === undefined
      ? {}
      : {
          problemKeywords: channel.problemKeywords
            .map((value: string) => value.trim())
            .filter(Boolean),
        }),
    ...(channel.automaticAssessmentEnabled === undefined
      ? {}
      : { automaticAssessmentEnabled: channel.automaticAssessmentEnabled }),
    ...(channel.internalUserIds === undefined
      ? {}
      : {
          internalUserIds: channel.internalUserIds
            .map((value: string) => value.trim())
            .filter(Boolean),
        }),
    ...(channel.reactionTriggerTypes === undefined
      ? {}
      : {
          reactionTriggerTypes: channel.reactionTriggerTypes
            .map((value: string) => value.trim().toLowerCase())
            .filter(Boolean),
        }),
    ...(channel.messageTagTriggers === undefined
      ? {}
      : {
          messageTagTriggers: channel.messageTagTriggers
            .map((value: string) => value.trim().toLowerCase())
            .filter(Boolean),
        }),
  }));
}
