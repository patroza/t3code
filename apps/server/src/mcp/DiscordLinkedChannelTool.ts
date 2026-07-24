// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off outdatedApi:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_DEFAULT_ALIASES_PATH = "/run/secrets/project-aliases.yaml";
const DISCORD_DEFAULT_ENV_FILE = "/run/secrets/discord-bot.env";
const DISCORD_DEFAULT_DATA_DIR = "/var/lib/t3/discord-bot";
const DISCORD_MESSAGE_FLAG_SUPPRESS_EMBEDS = 1 << 2;
const DISCORD_MESSAGE_FLAG_SUPPRESS_NOTIFICATIONS = 1 << 12;
const SHORT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface DiscordGuildSummary {
  readonly id: string;
  readonly name: string;
}

interface DiscordGuildChannel {
  readonly id: string;
  readonly guild_id?: string;
  readonly name?: string;
  readonly type?: number;
  readonly topic?: string | null;
}

interface DiscordMessageResponse {
  readonly id: string;
  readonly channel_id: string;
  readonly attachments?: ReadonlyArray<{
    readonly id: string;
    readonly filename: string;
    readonly size?: number;
    readonly url?: string;
  }>;
}

interface LinkedDiscordChannel {
  readonly guildId: string;
  readonly guildName: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly shortName: string;
  readonly topic: string;
}

interface DiscordAttachmentInput {
  readonly path: string;
  readonly filename?: string;
  readonly description?: string;
  readonly spoiler?: boolean;
}

interface DiscordEmbedInput {
  readonly title?: string;
  readonly description?: string;
  readonly url?: string;
  readonly color?: number;
  readonly fields?: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly inline?: boolean;
  }>;
  readonly footer?: {
    readonly text: string;
    readonly icon_url?: string;
  };
  readonly author?: {
    readonly name: string;
    readonly url?: string;
    readonly icon_url?: string;
  };
  readonly image?: { readonly url: string };
  readonly thumbnail?: { readonly url: string };
}

interface DiscordPollInput {
  readonly question: string;
  readonly answers: ReadonlyArray<string>;
  readonly durationHours?: number;
  readonly allowMultiselect?: boolean;
}

interface DiscordPostToolInput {
  readonly content?: string;
  readonly attachments?: ReadonlyArray<DiscordAttachmentInput>;
  readonly embeds?: ReadonlyArray<DiscordEmbedInput>;
  readonly poll?: DiscordPollInput;
  readonly replyToMessageId?: string;
  readonly tts?: boolean;
  readonly suppressEmbeds?: boolean;
  readonly suppressNotifications?: boolean;
}

interface MutableDiscordPostToolInput {
  content?: string;
  attachments?: ReadonlyArray<DiscordAttachmentInput>;
  embeds?: ReadonlyArray<DiscordEmbedInput>;
  poll?: DiscordPollInput;
  replyToMessageId?: string;
  tts?: boolean;
  suppressEmbeds?: boolean;
  suppressNotifications?: boolean;
}

interface DiscordUploadFile {
  readonly filename: string;
  readonly description?: string;
  readonly spoiler: boolean;
  readonly bytes: Uint8Array;
}

interface DiscordProjectAlias {
  readonly shortName: string;
  readonly workspaceRoot: string;
}

interface DiscordThreadLinkRecord {
  readonly discordThreadId: string;
  readonly t3ThreadId: string;
  readonly createdAt?: string;
}

function expandHomePath(value: string): string {
  if (!value) return value;
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(process.env.HOME ?? "", value.slice(2));
  }
  return value;
}

function normalizeDiscordProjectAliasShortName(raw: string): string | null {
  const shortName = raw.trim().toLowerCase();
  if (shortName.length === 0) return null;
  if (!SHORT_NAME_PATTERN.test(shortName)) return null;
  return shortName;
}

function normalizeDiscordProjectAliasWorkspaceRoot(raw: string): string {
  const expanded = expandHomePath(raw.trim());
  return expanded.replaceAll("\\", "/").replace(/\/+$/u, "") || expanded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseDiscordProjectAliasesYaml(raw: string): unknown {
  const lines = raw.split(/\r?\n/);
  const flat: Record<string, string> = {};
  const nested: Record<string, { workspaceRoot: string }> = {};
  let inAliasesBlock = false;
  let currentKey: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    if (/^aliases:\s*$/.test(trimmed)) {
      inAliasesBlock = true;
      continue;
    }

    const workspaceRootMatch = /^\s+workspaceRoot:\s*(.+)\s*$/.exec(line);
    if (workspaceRootMatch && currentKey !== null) {
      const value = stripYamlScalar(workspaceRootMatch[1]!);
      nested[currentKey] = { workspaceRoot: value };
      currentKey = null;
      continue;
    }

    const nestedKeyMatch = /^\s{2,}([A-Za-z0-9][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (nestedKeyMatch && inAliasesBlock) {
      currentKey = nestedKeyMatch[1]!;
      continue;
    }

    const flatMatch = /^([A-Za-z0-9][A-Za-z0-9_-]*):\s*(.+)\s*$/.exec(trimmed);
    if (flatMatch) {
      const key = flatMatch[1]!;
      const value = stripYamlScalar(flatMatch[2]!);
      if (key === "aliases") continue;
      flat[key] = value;
      currentKey = null;
    }
  }

  if (Object.keys(nested).length > 0) {
    return { aliases: nested };
  }
  return flat;
}

function parseDiscordProjectAliasesDocument(
  document: unknown,
  options?: { readonly resolveRelativeTo?: string },
): ReadonlyArray<DiscordProjectAlias> {
  const resolveRoot = (raw: string): string => {
    const expanded = expandHomePath(raw.trim());
    const absolute =
      options?.resolveRelativeTo !== undefined && !NodePath.isAbsolute(expanded)
        ? NodePath.resolve(options.resolveRelativeTo, expanded)
        : expanded;
    return normalizeDiscordProjectAliasWorkspaceRoot(absolute);
  };

  const entries = new Map<string, string>();

  const add = (shortNameRaw: string, workspaceRootRaw: string) => {
    const shortName = normalizeDiscordProjectAliasShortName(shortNameRaw);
    if (shortName === null) {
      throw new Error(`Invalid project alias shortName '${shortNameRaw}'.`);
    }
    const workspaceRoot = resolveRoot(workspaceRootRaw);
    if (workspaceRoot.trim().length === 0) {
      throw new Error(`Project alias '${shortName}' has an empty workspaceRoot.`);
    }
    if (entries.has(shortName)) {
      throw new Error(`Duplicate project alias shortName '${shortName}'.`);
    }
    entries.set(shortName, workspaceRoot);
  };

  if (Array.isArray(document)) {
    for (const item of document) {
      if (!isRecord(item)) {
        throw new Error("Project aliases array entries must be objects.");
      }
      const shortName = item.shortName;
      const workspaceRoot = item.workspaceRoot;
      if (typeof shortName !== "string" || typeof workspaceRoot !== "string") {
        throw new Error("Each project alias must include string shortName and workspaceRoot.");
      }
      add(shortName, workspaceRoot);
    }
  } else if (isRecord(document)) {
    const aliasesNode = document.aliases;
    const source = isRecord(aliasesNode) ? aliasesNode : document;
    for (const [key, value] of Object.entries(source)) {
      if (key === "aliases" && source === document) continue;
      if (typeof value === "string") {
        add(key, value);
        continue;
      }
      if (isRecord(value) && typeof value.workspaceRoot === "string") {
        add(key, value.workspaceRoot);
        continue;
      }
      throw new Error(
        `Project alias '${key}' must be a path string or an object with workspaceRoot.`,
      );
    }
  } else {
    throw new Error("Project aliases file must be a mapping, aliases object, or array.");
  }

  return [...entries.entries()]
    .map(([shortName, workspaceRoot]) => ({ shortName, workspaceRoot }))
    .toSorted((left, right) => left.shortName.localeCompare(right.shortName));
}

function loadDiscordProjectAliasesFromFileSync(
  filePath: string,
): ReadonlyArray<DiscordProjectAlias> {
  const resolvedPath = NodePath.resolve(expandHomePath(filePath.trim()));
  const raw = NodeFS.readFileSync(resolvedPath, "utf8");
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const document = resolvedPath.endsWith(".json")
    ? (JSON.parse(trimmed) as unknown)
    : parseDiscordProjectAliasesYaml(trimmed);
  return parseDiscordProjectAliasesDocument(document, {
    resolveRelativeTo: NodePath.dirname(resolvedPath),
  });
}

function findDiscordProjectAliasByWorkspaceRoot(
  aliases: ReadonlyArray<DiscordProjectAlias>,
  workspaceRoot: string,
): DiscordProjectAlias | null {
  const normalized = normalizeDiscordProjectAliasWorkspaceRoot(workspaceRoot);
  return aliases.find((entry) => entry.workspaceRoot === normalized) ?? null;
}

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

async function readOptionalTextFile(filePath: string): Promise<string | null> {
  try {
    return await NodeFSP.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function resolveDiscordBotToken(): Promise<string | null> {
  const fromEnv = process.env.DISCORD_BOT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const envFile = await readOptionalTextFile(DISCORD_DEFAULT_ENV_FILE);
  const fromFile = envFile ? extractEnvAssignment(envFile, "DISCORD_BOT_TOKEN")?.trim() : undefined;
  return fromFile && fromFile.length > 0 ? fromFile : null;
}

async function resolveDiscordAliasesPath(): Promise<string | null> {
  const fromEnv = process.env.T3_PROJECT_ALIASES_PATH?.trim();
  if (fromEnv) return fromEnv;
  const aliasesFile = await readOptionalTextFile(DISCORD_DEFAULT_ALIASES_PATH);
  return aliasesFile !== null ? DISCORD_DEFAULT_ALIASES_PATH : null;
}

function pickLinkedDiscordThreadId(document: unknown, t3ThreadId: string): string | null {
  if (!Array.isArray(document)) return null;
  const matches = document.filter(
    (entry): entry is DiscordThreadLinkRecord =>
      isRecord(entry) &&
      entry.t3ThreadId === t3ThreadId &&
      typeof entry.discordThreadId === "string" &&
      entry.discordThreadId.trim().length > 0,
  );
  return (
    matches.toSorted((left, right) =>
      String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
    )[0]?.discordThreadId ?? null
  );
}

async function resolveLinkedDiscordThreadId(t3ThreadId: string): Promise<string | null> {
  const dataDir = expandHomePath(
    process.env.T3_DISCORD_BOT_DATA_DIR?.trim() || DISCORD_DEFAULT_DATA_DIR,
  );
  const raw = await readOptionalTextFile(NodePath.join(dataDir, "links.json"));
  if (raw === null) return null;
  try {
    return pickLinkedDiscordThreadId(JSON.parse(raw) as unknown, t3ThreadId);
  } catch {
    return null;
  }
}

function resolveDiscordPostDestination(
  linkedChannelId: string,
  linkedThreadId: string | null,
): string {
  return linkedThreadId ?? linkedChannelId;
}

function parseTopicShortName(topic: string | null | undefined): string | null {
  if (!topic) return null;
  const match = /(?:^|\s)t3-([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/iu.exec(topic);
  return match?.[1]?.toLowerCase() ?? null;
}

function isSupportedLinkedChannel(channel: DiscordGuildChannel): boolean {
  return channel.type === 0 || channel.type === 5;
}

function pickLinkedDiscordChannel(input: {
  readonly guilds: ReadonlyArray<DiscordGuildSummary>;
  readonly channelsByGuildId: ReadonlyMap<string, ReadonlyArray<DiscordGuildChannel>>;
  readonly shortName: string;
}): {
  readonly match: LinkedDiscordChannel | null;
  readonly conflicts: ReadonlyArray<LinkedDiscordChannel>;
} {
  const matches: LinkedDiscordChannel[] = [];
  for (const guild of input.guilds) {
    for (const channel of input.channelsByGuildId.get(guild.id) ?? []) {
      if (!isSupportedLinkedChannel(channel) || typeof channel.topic !== "string") continue;
      const topicShortName = parseTopicShortName(channel.topic);
      if (topicShortName !== input.shortName) continue;
      matches.push({
        guildId: guild.id,
        guildName: guild.name,
        channelId: channel.id,
        channelName: channel.name ?? channel.id,
        shortName: input.shortName,
        topic: channel.topic,
      });
    }
  }

  if (matches.length !== 1) {
    return { match: null, conflicts: matches };
  }
  return { match: matches[0]!, conflicts: [] };
}

async function discordGetJson<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${DISCORD_API_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bot ${token}`,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord GET ${path} failed (${response.status}): ${body}`);
  }
  return (await response.json()) as T;
}

async function resolveLinkedChannel(input: {
  readonly token: string;
  readonly workspaceRoot: string;
}): Promise<LinkedDiscordChannel | null> {
  const aliasesPath = await resolveDiscordAliasesPath();
  if (!aliasesPath) return null;
  const aliases = loadDiscordProjectAliasesFromFileSync(aliasesPath);
  const alias = findDiscordProjectAliasByWorkspaceRoot(aliases, input.workspaceRoot);
  if (alias === null) return null;

  const guilds = await discordGetJson<ReadonlyArray<DiscordGuildSummary>>(
    input.token,
    "/users/@me/guilds",
  );
  const channelsByGuildId = new Map<string, ReadonlyArray<DiscordGuildChannel>>();
  await Promise.all(
    guilds.map(async (guild) => {
      const channels = await discordGetJson<ReadonlyArray<DiscordGuildChannel>>(
        input.token,
        `/guilds/${guild.id}/channels`,
      );
      channelsByGuildId.set(guild.id, channels);
    }),
  );

  const picked = pickLinkedDiscordChannel({
    guilds,
    channelsByGuildId,
    shortName: alias.shortName,
  });
  if (picked.conflicts.length > 1) {
    throw new Error(
      `Multiple linked Discord channels found for '${alias.shortName}': ${picked.conflicts
        .map((entry) => `${entry.guildName}/#${entry.channelName}`)
        .join(", ")}`,
    );
  }
  return picked.match;
}

function normalizeDiscordPostToolInput(payload: unknown): DiscordPostToolInput {
  if (typeof payload !== "object" || payload === null) return {};
  const record = payload as Record<string, unknown>;
  const normalized: MutableDiscordPostToolInput = {};
  if (typeof record.content === "string") normalized.content = record.content;
  if (Array.isArray(record.attachments)) {
    normalized.attachments = record.attachments.filter(
      (entry): entry is DiscordAttachmentInput =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { path?: unknown }).path === "string",
    );
  }
  if (Array.isArray(record.embeds)) {
    normalized.embeds = record.embeds.filter(
      (entry): entry is DiscordEmbedInput => typeof entry === "object" && entry !== null,
    ) as ReadonlyArray<DiscordEmbedInput>;
  }
  if (typeof record.poll === "object" && record.poll !== null) {
    normalized.poll = record.poll as DiscordPollInput;
  }
  if (typeof record.replyToMessageId === "string") {
    normalized.replyToMessageId = record.replyToMessageId;
  }
  if (record.tts === true) normalized.tts = true;
  if (record.suppressEmbeds === true) normalized.suppressEmbeds = true;
  if (record.suppressNotifications === true) normalized.suppressNotifications = true;
  return normalized;
}

function validateDiscordPostToolInput(input: DiscordPostToolInput): string | null {
  const hasContent = (input.content?.trim().length ?? 0) > 0;
  const hasAttachments = (input.attachments?.length ?? 0) > 0;
  const hasEmbeds = (input.embeds?.length ?? 0) > 0;
  const hasPoll = input.poll !== undefined;
  if (!hasContent && !hasAttachments && !hasEmbeds && !hasPoll) {
    return "Provide at least one of content, attachments, embeds, or poll.";
  }
  if (input.poll) {
    if (input.poll.question.trim().length === 0) {
      return "Poll question cannot be empty.";
    }
    if (!Array.isArray(input.poll.answers) || input.poll.answers.length < 2) {
      return "Polls require at least two answers.";
    }
  }
  return null;
}

async function readDiscordUploadFiles(
  attachments: ReadonlyArray<DiscordAttachmentInput>,
  cwd: string,
): Promise<ReadonlyArray<DiscordUploadFile>> {
  return Promise.all(
    attachments.map(async (attachment) => {
      const resolvedPath = NodePath.isAbsolute(attachment.path)
        ? attachment.path
        : NodePath.resolve(cwd, attachment.path);
      const bytes = await NodeFSP.readFile(resolvedPath);
      const requestedName = attachment.filename?.trim();
      const baseFilename =
        requestedName && requestedName.length > 0 ? requestedName : NodePath.basename(resolvedPath);
      return {
        filename:
          attachment.spoiler === true && !baseFilename.startsWith("SPOILER_")
            ? `SPOILER_${baseFilename}`
            : baseFilename,
        spoiler: attachment.spoiler === true,
        bytes,
        ...(attachment.description?.trim() ? { description: attachment.description.trim() } : {}),
      };
    }),
  );
}

function buildDiscordCreateMessageBody(
  input: DiscordPostToolInput,
  files: ReadonlyArray<DiscordUploadFile>,
) {
  const flags =
    (input.suppressEmbeds ? DISCORD_MESSAGE_FLAG_SUPPRESS_EMBEDS : 0) |
    (input.suppressNotifications ? DISCORD_MESSAGE_FLAG_SUPPRESS_NOTIFICATIONS : 0);
  return {
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.tts ? { tts: true } : {}),
    ...(input.embeds && input.embeds.length > 0 ? { embeds: input.embeds } : {}),
    ...(flags !== 0 ? { flags } : {}),
    allowed_mentions: { parse: [] as string[] },
    ...(input.replyToMessageId
      ? {
          message_reference: {
            message_id: input.replyToMessageId,
            fail_if_not_exists: false,
          },
          allowed_mentions: { parse: [] as string[], replied_user: false },
        }
      : {}),
    ...(input.poll
      ? {
          poll: {
            question: { text: input.poll.question },
            answers: input.poll.answers.map((answer) => ({ poll_media: { text: answer } })),
            duration: input.poll.durationHours ?? 24,
            allow_multiselect: input.poll.allowMultiselect === true,
          },
        }
      : {}),
    ...(files.length > 0
      ? {
          attachments: files.map((file, index) => ({
            id: index,
            filename: file.filename,
            ...(file.description ? { description: file.description } : {}),
            ...(file.spoiler ? { is_spoiler: true } : {}),
          })),
        }
      : {}),
  };
}

async function createDiscordMessage(input: {
  readonly token: string;
  readonly channelId: string;
  readonly body: ReturnType<typeof buildDiscordCreateMessageBody>;
  readonly files: ReadonlyArray<DiscordUploadFile>;
}): Promise<DiscordMessageResponse> {
  const url = `${DISCORD_API_BASE_URL}/channels/${input.channelId}/messages`;
  const response =
    input.files.length === 0
      ? await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bot ${input.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input.body),
        })
      : await (async () => {
          const formData = new FormData();
          formData.set("payload_json", JSON.stringify(input.body));
          input.files.forEach((file, index) => {
            formData.set(`files[${index}]`, new Blob([file.bytes]), file.filename);
          });
          return fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bot ${input.token}`,
            },
            body: formData,
          });
        })();

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord create message failed (${response.status}): ${body}`);
  }
  return (await response.json()) as DiscordMessageResponse;
}

function errorResult(message: string, tag = "DiscordLinkedChannelPostError") {
  return new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: tag,
        message,
      },
    },
    content: [{ type: "text", text: message }],
  });
}

export const registerDiscordLinkedChannelPostTool = Effect.fn("DiscordLinkedChannelTool.register")(
  function* () {
    const server = yield* McpServer.McpServer;
    const snapshotQuery = yield* ProjectionSnapshotQuery;

    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: "discord_post_to_linked_channel",
        description:
          "Post to the Discord thread linked to the active T3 thread, falling back to the repository channel linked via a `t3-<shortName>` topic tag. Supports file attachments, rich embeds, and polls.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "Plain message content." },
            attachments: {
              type: "array",
              description:
                "Local files to upload. Relative paths resolve from the current thread workspace.",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  filename: { type: "string" },
                  description: { type: "string" },
                  spoiler: { type: "boolean" },
                },
                required: ["path"],
                additionalProperties: false,
              },
            },
            embeds: {
              type: "array",
              description:
                "Discord rich embeds. Uploaded files can be referenced with attachment://filename URLs.",
              items: { type: "object" },
            },
            poll: {
              type: "object",
              properties: {
                question: { type: "string" },
                answers: { type: "array", items: { type: "string" } },
                durationHours: { type: "integer", minimum: 1, maximum: 768 },
                allowMultiselect: { type: "boolean" },
              },
              required: ["question", "answers"],
              additionalProperties: false,
            },
            replyToMessageId: { type: "string" },
            tts: { type: "boolean" },
            suppressEmbeds: { type: "boolean" },
            suppressNotifications: { type: "boolean" },
          },
          additionalProperties: false,
        },
        annotations: {
          title: "Post to linked Discord channel",
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      }),
      annotations: Context.empty(),
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          const input = normalizeDiscordPostToolInput(payload);
          const validationError = validateDiscordPostToolInput(input);
          if (validationError) {
            return Effect.succeed(errorResult(validationError, "InvalidDiscordPostInput"));
          }

          return Effect.gen(function* () {
            const threadShell = yield* snapshotQuery.getThreadShellById(invocation.threadId);
            if (Option.isNone(threadShell)) {
              return errorResult(`Thread ${invocation.threadId} was not found.`, "ThreadNotFound");
            }
            const projectShell = yield* snapshotQuery.getProjectShellById(
              threadShell.value.projectId,
            );
            if (Option.isNone(projectShell)) {
              return errorResult(
                `Project ${threadShell.value.projectId} was not found for this thread.`,
                "ProjectNotFound",
              );
            }

            const token = yield* Effect.promise(() => resolveDiscordBotToken());
            if (!token) {
              return errorResult(
                "Discord posting is unavailable because no Discord bot token is configured.",
                "DiscordUnavailable",
              );
            }

            const linkedChannel = yield* Effect.promise(() =>
              resolveLinkedChannel({
                token,
                workspaceRoot: projectShell.value.workspaceRoot,
              }),
            );
            if (linkedChannel === null) {
              return errorResult(
                `No linked Discord channel was found for repository workspace '${projectShell.value.workspaceRoot}'.`,
                "LinkedChannelNotFound",
              );
            }

            const cwd = threadShell.value.worktreePath ?? projectShell.value.workspaceRoot;
            const discordThreadId = yield* Effect.promise(() =>
              resolveLinkedDiscordThreadId(invocation.threadId),
            );
            const destinationId = resolveDiscordPostDestination(
              linkedChannel.channelId,
              discordThreadId,
            );
            const files = yield* Effect.promise(() =>
              readDiscordUploadFiles(input.attachments ?? [], cwd),
            );
            const body = buildDiscordCreateMessageBody(input, files);
            const message = yield* Effect.promise(() =>
              createDiscordMessage({
                token,
                channelId: destinationId,
                body,
                files,
              }),
            );

            return new McpSchema.CallToolResult({
              isError: false,
              structuredContent: {
                shortName: linkedChannel.shortName,
                guildId: linkedChannel.guildId,
                guildName: linkedChannel.guildName,
                channelId: linkedChannel.channelId,
                channelName: linkedChannel.channelName,
                destinationId,
                discordThreadId,
                messageId: message.id,
                attachmentCount: message.attachments?.length ?? 0,
              },
              content: [
                {
                  type: "text",
                  text:
                    discordThreadId === null
                      ? `Posted to Discord ${linkedChannel.guildName}/#${linkedChannel.channelName}.`
                      : `Posted to the linked Discord thread in ${linkedChannel.guildName}/#${linkedChannel.channelName}.`,
                },
              ],
            });
          }).pipe(
            Effect.catch((error: unknown) =>
              Effect.succeed(
                errorResult(
                  error instanceof Error ? error.message : String(error),
                  "DiscordLinkedChannelPostError",
                ),
              ),
            ),
          );
        }),
    });
  },
);

export const __testing = {
  extractEnvAssignment,
  parseTopicShortName,
  pickLinkedDiscordChannel,
  pickLinkedDiscordThreadId,
  resolveDiscordPostDestination,
};
