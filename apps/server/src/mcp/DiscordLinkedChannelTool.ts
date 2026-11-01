// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off outdatedApi:off
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  githubRepositoryRefsOf,
  parseTopicProjectBinding,
  parseTopicShortName,
  topicProjectBindingLabel,
  type GithubRepositoryRef,
} from "@t3tools/shared/discordProjectTopic";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { Tool, Toolkit } from "effect/ai";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_DEFAULT_ALIASES_PATH = "/run/secrets/project-aliases.yaml";
const DISCORD_DEFAULT_ENV_FILE = "/run/secrets/discord-bot.env";
const DISCORD_DEFAULT_DATA_DIR = "/var/lib/t3/discord-bot";
const DISCORD_LINKS_FILE = "links.json";
// Separate from links.json: ThreadRestore starts ResponseBridge for every active
// link, and one invalid links.json document decodes as an empty link list.
const DISCORD_POST_THREADS_FILE = "discord-post-threads.json";
const DISCORD_POST_THREADS_VERSION = 1;
const DISCORD_UNLINKED_POSTS_ENV = "T3_DISCORD_POST_UNLINKED_THREADS";
const DISCORD_PUBLIC_THREAD_TYPE = 11;
const DISCORD_THREAD_ARCHIVE_MINUTES = 1440;
const DISCORD_THREAD_NAME_MAX = 100;
const DISCORD_UNKNOWN_CHANNEL_CODE = 10003;
const DISCORD_LINKS_UNREADABLE_MESSAGE =
  "Discord link map links.json is unreadable; refusing to post or open a thread.";
const DISCORD_TOP_LEVEL_POST_MESSAGE = "Refusing to post a top-level Discord channel message.";
const DISCORD_MESSAGE_FLAG_SUPPRESS_EMBEDS = 1 << 2;
const DISCORD_MESSAGE_FLAG_SUPPRESS_NOTIFICATIONS = 1 << 12;
const SKIPPED_NOT_DISCORD_LINKED_SUMMARY =
  "Skipped Discord post: this T3 thread is not linked to a Discord thread. Set T3_DISCORD_POST_UNLINKED_THREADS=1 to open a thread in the repository channel.";
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
  readonly filename?: string | undefined;
  readonly description?: string | undefined;
  readonly spoiler?: boolean | undefined;
}

interface DiscordPollInput {
  readonly question: string;
  readonly answers: ReadonlyArray<string>;
  readonly durationHours?: number | undefined;
  readonly allowMultiselect?: boolean | undefined;
}

interface DiscordPostToolInput {
  readonly content?: string | undefined;
  readonly attachments?: ReadonlyArray<DiscordAttachmentInput> | undefined;
  readonly embeds?: ReadonlyArray<{ readonly [key: string]: unknown }> | undefined;
  readonly poll?: DiscordPollInput | undefined;
  readonly replyToMessageId?: string | undefined;
  readonly tts?: boolean | undefined;
  readonly suppressEmbeds?: boolean | undefined;
  readonly suppressNotifications?: boolean | undefined;
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
  readonly updatedAt?: string;
  readonly lastActivityAt?: string;
  readonly status?: string;
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

type DiscordTextFileRead =
  | { readonly status: "missing" }
  | { readonly status: "unreadable" }
  | { readonly status: "ok"; readonly text: string };

function errnoCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/** ENOENT is missing. Every other read failure stays unreadable so callers do not rewrite the file. */
async function readDiscordTextFile(filePath: string): Promise<DiscordTextFileRead> {
  try {
    return { status: "ok", text: await NodeFSP.readFile(filePath, "utf8") };
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? { status: "missing" } : { status: "unreadable" };
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

function linksFromDocument(document: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(document)) return document;
  if (isRecord(document) && Array.isArray(document.links)) return document.links;
  return [];
}

function isDiscordThreadLinkRecord(entry: unknown): entry is DiscordThreadLinkRecord {
  return (
    isRecord(entry) &&
    typeof entry.t3ThreadId === "string" &&
    typeof entry.discordThreadId === "string" &&
    entry.discordThreadId.trim().length > 0
  );
}

function linkRecency(entry: DiscordThreadLinkRecord): string {
  return entry.lastActivityAt ?? entry.updatedAt ?? entry.createdAt ?? "";
}

function pickLinkedDiscordThreadId(document: unknown, t3ThreadId: string): string | null {
  const matches = linksFromDocument(document).filter(
    (entry): entry is DiscordThreadLinkRecord =>
      isDiscordThreadLinkRecord(entry) && entry.t3ThreadId === t3ThreadId,
  );
  const active = matches.filter((entry) => entry.status !== "tombstone");
  const pool = active.length > 0 ? active : matches;
  return (
    pool.toSorted((left, right) => linkRecency(right).localeCompare(linkRecency(left)))[0]
      ?.discordThreadId ?? null
  );
}

function pickActiveLinkedDiscordThreadId(document: unknown, t3ThreadId: string): string | null {
  const matches = linksFromDocument(document).filter(
    (entry): entry is DiscordThreadLinkRecord =>
      isDiscordThreadLinkRecord(entry) &&
      entry.t3ThreadId === t3ThreadId &&
      entry.status !== "tombstone",
  );
  const discordThreadId =
    matches.toSorted((left, right) => linkRecency(right).localeCompare(linkRecency(left)))[0]
      ?.discordThreadId ?? null;
  const trimmed = discordThreadId?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function discordBotDataDir(): string {
  return expandHomePath(process.env.T3_DISCORD_BOT_DATA_DIR?.trim() || DISCORD_DEFAULT_DATA_DIR);
}

type ActiveDiscordLinkLookup =
  | { readonly status: "unreadable" }
  | { readonly status: "ready"; readonly discordThreadId: string | null };

function activeDiscordLinkFromFile(
  read: DiscordTextFileRead,
  t3ThreadId: string,
): ActiveDiscordLinkLookup {
  if (read.status === "unreadable") return { status: "unreadable" };
  if (read.status === "missing" || read.text.trim().length === 0) {
    return { status: "ready", discordThreadId: null };
  }
  try {
    return {
      status: "ready",
      discordThreadId: pickActiveLinkedDiscordThreadId(
        JSON.parse(read.text) as unknown,
        t3ThreadId,
      ),
    };
  } catch {
    return { status: "unreadable" };
  }
}

async function lookupActiveLinkedDiscordThread(
  t3ThreadId: string,
): Promise<ActiveDiscordLinkLookup> {
  const read = await readDiscordTextFile(NodePath.join(discordBotDataDir(), DISCORD_LINKS_FILE));
  return activeDiscordLinkFromFile(read, t3ThreadId);
}

const UNLINKED_DISCORD_POST_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);

function unlinkedDiscordPostsEnabledFrom(
  envValue: string | undefined,
  fileContents: string | null,
): boolean {
  const raw =
    envValue !== undefined
      ? envValue
      : fileContents === null
        ? undefined
        : extractEnvAssignment(fileContents, DISCORD_UNLINKED_POSTS_ENV);
  if (raw === undefined) return false;
  return UNLINKED_DISCORD_POST_FLAG_VALUES.has(raw.trim().toLowerCase());
}

async function resolveUnlinkedDiscordPostsEnabled(): Promise<boolean> {
  if (Object.prototype.hasOwnProperty.call(process.env, DISCORD_UNLINKED_POSTS_ENV)) {
    return unlinkedDiscordPostsEnabledFrom(process.env[DISCORD_UNLINKED_POSTS_ENV] ?? "", null);
  }
  const envFile = await readOptionalTextFile(DISCORD_DEFAULT_ENV_FILE);
  return unlinkedDiscordPostsEnabledFrom(undefined, envFile);
}

type DiscordPostDecision =
  | { readonly action: "post"; readonly discordThreadId: string }
  | { readonly action: "skip"; readonly reason: "not-discord-linked" }
  | { readonly action: "open-thread" };

function decideDiscordPost(input: {
  readonly linkedDiscordThreadId: string | null;
  readonly unlinkedPostsEnabled: boolean;
}): DiscordPostDecision {
  const linked = input.linkedDiscordThreadId?.trim() ?? "";
  if (linked.length > 0) return { action: "post", discordThreadId: linked };
  if (!input.unlinkedPostsEnabled) return { action: "skip", reason: "not-discord-linked" };
  return { action: "open-thread" };
}

function discordThreadNameFromTitle(title: string): string {
  const collapsed = title.replace(/\s+/gu, " ").trim();
  const shortened = Array.from(collapsed).slice(0, DISCORD_THREAD_NAME_MAX).join("").trim();
  return shortened.length > 0 ? shortened : "T3 thread";
}

function buildDiscordPublicThreadBody(name: string): {
  readonly name: string;
  readonly type: 11;
  readonly auto_archive_duration: 1440;
} {
  return {
    name,
    type: DISCORD_PUBLIC_THREAD_TYPE,
    auto_archive_duration: DISCORD_THREAD_ARCHIVE_MINUTES,
  };
}

interface DiscordPostThreadRecord {
  readonly t3ThreadId: string;
  readonly discordThreadId: string;
  readonly channelId: string;
  readonly guildId: string;
  readonly name: string;
  readonly createdAt: string;
}

type DiscordPostThreadStoreReason = "unreadable" | "unsupported" | "invalid entry";

type DiscordPostThreadStoreRead =
  | { readonly ok: true; readonly threads: ReadonlyArray<DiscordPostThreadRecord> }
  | { readonly ok: false; readonly reason: DiscordPostThreadStoreReason };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function discordPostThreadRecordFrom(entry: unknown): DiscordPostThreadRecord | null {
  if (!isRecord(entry)) return null;
  if (
    !nonEmptyString(entry.t3ThreadId) ||
    !nonEmptyString(entry.discordThreadId) ||
    !nonEmptyString(entry.channelId) ||
    !nonEmptyString(entry.guildId) ||
    !nonEmptyString(entry.name) ||
    !nonEmptyString(entry.createdAt)
  ) {
    return null;
  }
  return {
    t3ThreadId: entry.t3ThreadId.trim(),
    discordThreadId: entry.discordThreadId.trim(),
    channelId: entry.channelId.trim(),
    guildId: entry.guildId.trim(),
    name: entry.name.trim(),
    createdAt: entry.createdAt.trim(),
  };
}

function parseDiscordPostThreadStore(raw: string): DiscordPostThreadStoreRead {
  if (raw.trim().length === 0) return { ok: true, threads: [] };
  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (
    !isRecord(document) ||
    document.version !== DISCORD_POST_THREADS_VERSION ||
    !Array.isArray(document.threads)
  ) {
    return { ok: false, reason: "unsupported" };
  }
  const threads: DiscordPostThreadRecord[] = [];
  for (const entry of document.threads) {
    const record = discordPostThreadRecordFrom(entry);
    if (record === null) return { ok: false, reason: "invalid entry" };
    threads.push(record);
  }
  return { ok: true, threads };
}

function pickStoredDiscordPostThread(
  threads: ReadonlyArray<DiscordPostThreadRecord>,
  t3ThreadId: string,
): DiscordPostThreadRecord | null {
  let best: DiscordPostThreadRecord | null = null;
  for (const entry of threads) {
    if (entry.t3ThreadId !== t3ThreadId) continue;
    if (best === null || entry.createdAt >= best.createdAt) best = entry;
  }
  return best;
}

type StoredDiscordPostThreadPlan =
  | { readonly action: "reuse"; readonly record: DiscordPostThreadRecord }
  | { readonly action: "create" }
  | { readonly action: "fail"; readonly reason: DiscordPostThreadStoreReason };

function planStoredDiscordPostThread(input: {
  readonly store: DiscordPostThreadStoreRead;
  readonly t3ThreadId: string;
}): StoredDiscordPostThreadPlan {
  if (!input.store.ok) return { action: "fail", reason: input.store.reason };
  const record = pickStoredDiscordPostThread(input.store.threads, input.t3ThreadId);
  return record === null ? { action: "create" } : { action: "reuse", record };
}

async function readDiscordPostThreadStore(dataDir: string): Promise<DiscordPostThreadStoreRead> {
  const read = await readDiscordTextFile(NodePath.join(dataDir, DISCORD_POST_THREADS_FILE));
  if (read.status === "missing") return { ok: true, threads: [] };
  if (read.status === "unreadable") return { ok: false, reason: "unreadable" };
  return parseDiscordPostThreadStore(read.text);
}

async function writeDiscordPostThreadStore(
  dataDir: string,
  threads: ReadonlyArray<DiscordPostThreadRecord>,
): Promise<void> {
  await NodeFSP.mkdir(dataDir, { recursive: true });
  const target = NodePath.join(dataDir, DISCORD_POST_THREADS_FILE);
  const temporary = NodePath.join(dataDir, discordPostThreadTempName());
  const payload = `${JSON.stringify({ version: DISCORD_POST_THREADS_VERSION, threads }, null, 2)}\n`;
  try {
    await NodeFSP.writeFile(temporary, payload, "utf8");
    await NodeFSP.rename(temporary, target);
  } catch (error) {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertDiscordThreadDestination(threadId: string, parentChannelId: string): string {
  const destination = threadId.trim();
  if (destination.length === 0 || destination === parentChannelId.trim()) {
    throw new Error(DISCORD_TOP_LEVEL_POST_MESSAGE);
  }
  return destination;
}

function assertReusableDiscordPostThread(
  record: DiscordPostThreadRecord,
  currentChannelId: string,
): string {
  const destination = assertDiscordThreadDestination(record.discordThreadId, currentChannelId);
  return assertDiscordThreadDestination(destination, record.channelId);
}

function discordThreadIdFromCreateResponse(body: unknown, parentChannelId: string): string {
  if (!isRecord(body) || typeof body.id !== "string") {
    throw new Error("Discord create thread returned no thread id.");
  }
  if (typeof body.parent_id === "string" && body.parent_id !== parentChannelId) {
    throw new Error("Discord create thread returned a thread in a different channel.");
  }
  return assertDiscordThreadDestination(body.id, parentChannelId);
}

function isUnknownDiscordChannel(cause: unknown): boolean {
  const message = messageFromUnknown(cause);
  const jsonStart = message.indexOf("{");
  if (jsonStart < 0) return false;
  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as unknown;
    if (!isRecord(parsed)) return false;
    return (
      parsed.code === DISCORD_UNKNOWN_CHANNEL_CODE ||
      parsed.code === String(DISCORD_UNKNOWN_CHANNEL_CODE)
    );
  } catch {
    return false;
  }
}

function isSupportedLinkedChannel(channel: DiscordGuildChannel): boolean {
  return channel.type === 0 || channel.type === 5;
}

interface LinkedChannelTarget {
  readonly shortName: string | null;
  readonly repositories: readonly GithubRepositoryRef[];
}

/**
 * Rank 0 is a GitHub topic tag this project answers to.
 * Rank 1 is the legacy alias short name. A channel that has a GitHub tag does
 * not also match through a sibling short name.
 */
function linkedChannelRank(topic: string, target: LinkedChannelTarget): 0 | 1 | null {
  const binding = parseTopicProjectBinding(topic);
  if (binding === null) return null;
  if (binding.kind === "github") {
    const matches = target.repositories.some(
      (repository) =>
        repository.owner === binding.repository.owner &&
        repository.repo === binding.repository.repo,
    );
    return matches ? 0 : null;
  }
  return target.shortName !== null && binding.shortName === target.shortName ? 1 : null;
}

function pickLinkedDiscordChannel(input: {
  readonly guilds: ReadonlyArray<DiscordGuildSummary>;
  readonly channelsByGuildId: ReadonlyMap<string, ReadonlyArray<DiscordGuildChannel>>;
  readonly target: LinkedChannelTarget;
}): {
  readonly match: LinkedDiscordChannel | null;
  readonly conflicts: ReadonlyArray<LinkedDiscordChannel>;
} {
  const ranked: Array<{ readonly channel: LinkedDiscordChannel; readonly rank: 0 | 1 }> = [];
  for (const guild of input.guilds) {
    for (const channel of input.channelsByGuildId.get(guild.id) ?? []) {
      if (!isSupportedLinkedChannel(channel) || typeof channel.topic !== "string") continue;
      const rank = linkedChannelRank(channel.topic, input.target);
      if (rank === null) continue;
      const binding = parseTopicProjectBinding(channel.topic);
      if (binding === null) continue;
      ranked.push({
        rank,
        channel: {
          guildId: guild.id,
          guildName: guild.name,
          channelId: channel.id,
          channelName: channel.name ?? channel.id,
          shortName: topicProjectBindingLabel(binding),
          topic: channel.topic,
        },
      });
    }
  }

  const best = ranked.reduce<0 | 1 | null>(
    (lowest, entry) => (lowest === null || entry.rank < lowest ? entry.rank : lowest),
    null,
  );
  if (best === null) return { match: null, conflicts: [] };
  const winners = ranked.filter((entry) => entry.rank === best).map((entry) => entry.channel);
  if (winners.length !== 1) {
    return { match: null, conflicts: winners };
  }
  return { match: winners[0]!, conflicts: [] };
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
  readonly repositories: readonly GithubRepositoryRef[];
}): Promise<LinkedDiscordChannel | null> {
  const aliasesPath = await resolveDiscordAliasesPath();
  const shortName =
    aliasesPath === null
      ? null
      : (findDiscordProjectAliasByWorkspaceRoot(
          loadDiscordProjectAliasesFromFileSync(aliasesPath),
          input.workspaceRoot,
        )?.shortName ?? null);
  if (shortName === null && input.repositories.length === 0) return null;

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
    target: { shortName, repositories: input.repositories },
  });
  if (picked.conflicts.length > 1) {
    const label = picked.conflicts[0]?.shortName ?? shortName ?? input.workspaceRoot;
    throw new Error(
      `Multiple linked Discord channels found for '${label}': ${picked.conflicts
        .map((entry) => `${entry.guildName}/#${entry.channelName}`)
        .join(", ")}`,
    );
  }
  return picked.match;
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

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function appendDiscordUploadFiles(form: FormData, files: ReadonlyArray<DiscordUploadFile>): void {
  files.forEach((file, index) => {
    const filename = file.filename.trim() !== "" ? file.filename.trim() : "attachment.bin";
    form.append(
      `files[${index}]`,
      new File([copyBytes(file.bytes)], filename, {
        type: "application/octet-stream",
      }),
    );
  });
}

function buildDiscordMultipartForm(input: {
  readonly body: ReturnType<typeof buildDiscordCreateMessageBody>;
  readonly files: ReadonlyArray<DiscordUploadFile>;
}): FormData {
  const formData = new FormData();
  formData.append("payload_json", JSON.stringify(input.body));
  appendDiscordUploadFiles(formData, input.files);
  return formData;
}

function messageFromUnknown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
            "User-Agent": "DiscordBot (t3-discord-bot, 0.0.0)",
          },
          body: JSON.stringify(input.body),
        })
      : await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bot ${input.token}`,
            "User-Agent": "DiscordBot (t3-discord-bot, 0.0.0)",
          },
          body: buildDiscordMultipartForm({ body: input.body, files: input.files }),
        });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord create message failed (${response.status}): ${body}`);
  }
  return (await response.json()) as DiscordMessageResponse;
}

async function deleteDiscordThread(token: string, threadId: string): Promise<void> {
  const response = await fetch(`${DISCORD_API_BASE_URL}/channels/${threadId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "DiscordBot (t3-discord-bot, 0.0.0)",
    },
  });
  if (response.ok || response.status === 404) return;
  const body = await response.text();
  throw new Error(`Discord delete thread failed (${response.status}): ${body}`);
}

async function createDiscordPublicThread(input: {
  readonly token: string;
  readonly channelId: string;
  readonly name: string;
}): Promise<unknown> {
  const response = await fetch(`${DISCORD_API_BASE_URL}/channels/${input.channelId}/threads`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${input.token}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (t3-discord-bot, 0.0.0)",
    },
    body: JSON.stringify(buildDiscordPublicThreadBody(input.name)),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord create thread failed (${response.status}): ${body}`);
  }
  return response.json() as Promise<unknown>;
}

interface RememberedDiscordPostThread extends DiscordPostThreadRecord {
  readonly persisted: boolean;
}

const discordPostThreadMemory = new Map<string, RememberedDiscordPostThread>();
let discordPostThreadLock: Promise<unknown> = Promise.resolve();

function withDiscordPostThreadLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = discordPostThreadLock.then(operation, operation);
  discordPostThreadLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let discordPostThreadTempSequence = 0;

function discordPostThreadTempName(): string {
  discordPostThreadTempSequence += 1;
  return `.${DISCORD_POST_THREADS_FILE}.${process.pid}.${discordPostThreadTempSequence}.tmp`;
}

function isoTimestampNow(): string {
  // Sync side-store timestamp. This helper runs outside an Effect.
  // @effect-diagnostics-next-line globalDate:off
  return DateTime.formatIso(DateTime.makeUnsafe(Date.now()));
}

function discordPostThreadMapFailure(reason: DiscordPostThreadStoreReason): Error {
  return new Error(`Discord post thread map is ${reason}; refusing to open another thread.`);
}

function discordPostThreadStoreRecord(record: DiscordPostThreadRecord): DiscordPostThreadRecord {
  return {
    t3ThreadId: record.t3ThreadId,
    discordThreadId: record.discordThreadId,
    channelId: record.channelId,
    guildId: record.guildId,
    name: record.name,
    createdAt: record.createdAt,
  };
}

async function persistDiscordPostThreadRecord(
  dataDir: string,
  record: DiscordPostThreadRecord,
): Promise<boolean> {
  const existing = await readDiscordPostThreadStore(dataDir);
  if (!existing.ok) return false;
  const stored = discordPostThreadStoreRecord(record);
  const next = [
    ...existing.threads.filter(
      (entry) =>
        !(
          entry.t3ThreadId === stored.t3ThreadId && entry.discordThreadId === stored.discordThreadId
        ),
    ),
    stored,
  ];
  try {
    await writeDiscordPostThreadStore(dataDir, next);
    return true;
  } catch {
    // One retry of the snapshot that was read. Do not re-read and do not replace a bad map.
    try {
      await writeDiscordPostThreadStore(dataDir, next);
      return true;
    } catch {
      return false;
    }
  }
}

function rememberPersistedDiscordPostThread(record: DiscordPostThreadRecord): string {
  discordPostThreadMemory.set(record.t3ThreadId, { ...record, persisted: true });
  return record.discordThreadId;
}

async function saveCreatedDiscordPostThread(input: {
  readonly record: DiscordPostThreadRecord;
  readonly dataDir: string;
  readonly deleteThread: (discordThreadId: string) => Promise<void>;
}): Promise<string> {
  const persisted = await persistDiscordPostThreadRecord(input.dataDir, input.record);
  if (!persisted) {
    try {
      await input.deleteThread(input.record.discordThreadId);
    } catch (error) {
      discordPostThreadMemory.set(input.record.t3ThreadId, { ...input.record, persisted: false });
      throw new Error(
        `Discord post thread map could not be saved, and deleting the new thread failed: ${messageFromUnknown(error)}`,
        { cause: error },
      );
    }
    throw new Error("Discord post thread map could not be saved; refusing to post.");
  }
  return rememberPersistedDiscordPostThread(input.record);
}

function rememberedDiscordPostThread(t3ThreadId: string): RememberedDiscordPostThread | null {
  return discordPostThreadMemory.get(t3ThreadId) ?? null;
}

function rememberedDiscordPostThreadId(t3ThreadId: string): string | null {
  return rememberedDiscordPostThread(t3ThreadId)?.discordThreadId ?? null;
}

function clearDiscordPostThreadMemory(): void {
  discordPostThreadMemory.clear();
}

interface EnsuredDiscordPostThread {
  readonly discordThreadId: string;
  readonly sideStore: boolean;
}

// A links.json row can appear after the pre-lock lookup, including while the
// repository channel is resolved and during Unknown Channel recovery.
async function readLinkedDiscordPostThread(
  lookupLink: (t3ThreadId: string) => Promise<ActiveDiscordLinkLookup>,
  t3ThreadId: string,
  channelId: string,
): Promise<{ readonly discordThreadId: string; readonly sideStore: false } | null> {
  const lookup = await lookupLink(t3ThreadId);
  if (lookup.status === "unreadable") throw new Error(DISCORD_LINKS_UNREADABLE_MESSAGE);
  if (lookup.discordThreadId === null) return null;
  return {
    discordThreadId: assertDiscordThreadDestination(lookup.discordThreadId, channelId),
    sideStore: false,
  };
}

async function retryUnpersistedDiscordPostThread(input: {
  readonly dataDir: string;
  readonly channelId: string;
  readonly record: RememberedDiscordPostThread;
}): Promise<string> {
  const destination = assertReusableDiscordPostThread(input.record, input.channelId);
  if (input.record.persisted) return destination;
  const saved = await persistDiscordPostThreadRecord(input.dataDir, input.record);
  if (!saved) {
    throw new Error("Discord post thread map could not be saved; refusing to post.");
  }
  rememberPersistedDiscordPostThread(input.record);
  return destination;
}

async function ensureDiscordPostThreadUnlocked(input: {
  readonly token: string;
  readonly t3ThreadId: string;
  readonly channelId: string;
  readonly guildId: string;
  readonly title: string;
  readonly dataDir?: string;
  readonly lookupLink?: (t3ThreadId: string) => Promise<ActiveDiscordLinkLookup>;
  readonly createThread?: (input: {
    readonly token: string;
    readonly channelId: string;
    readonly name: string;
  }) => Promise<unknown>;
}): Promise<EnsuredDiscordPostThread> {
  const dataDir = input.dataDir ?? discordBotDataDir();
  const lookupLink = input.lookupLink ?? lookupActiveLinkedDiscordThread;
  const createThread = input.createThread ?? createDiscordPublicThread;
  const remembered = discordPostThreadMemory.get(input.t3ThreadId);
  if (remembered) {
    const linked = await readLinkedDiscordPostThread(lookupLink, input.t3ThreadId, input.channelId);
    if (linked) return linked;
    return {
      discordThreadId: await retryUnpersistedDiscordPostThread({
        dataDir,
        channelId: input.channelId,
        record: remembered,
      }),
      sideStore: true,
    };
  }

  const store = await readDiscordPostThreadStore(dataDir);
  const plan = planStoredDiscordPostThread({ store, t3ThreadId: input.t3ThreadId });
  if (plan.action === "fail") throw discordPostThreadMapFailure(plan.reason);
  if (plan.action === "reuse") {
    const linked = await readLinkedDiscordPostThread(lookupLink, input.t3ThreadId, input.channelId);
    if (linked) return linked;
    const discordThreadId = assertReusableDiscordPostThread(plan.record, input.channelId);
    rememberPersistedDiscordPostThread(plan.record);
    return { discordThreadId, sideStore: true };
  }

  const linked = await readLinkedDiscordPostThread(lookupLink, input.t3ThreadId, input.channelId);
  if (linked) return linked;

  const name = discordThreadNameFromTitle(input.title);
  const created = discordThreadIdFromCreateResponse(
    await createThread({
      token: input.token,
      channelId: input.channelId,
      name,
    }),
    input.channelId,
  );
  const discordThreadId = await saveCreatedDiscordPostThread({
    dataDir,
    deleteThread: (discordThreadId) => deleteDiscordThread(input.token, discordThreadId),
    record: {
      t3ThreadId: input.t3ThreadId,
      discordThreadId: created,
      channelId: input.channelId,
      guildId: input.guildId,
      name,
      createdAt: isoTimestampNow(),
    },
  });
  return { discordThreadId, sideStore: true };
}

async function forgetDiscordPostThreadUnlocked(
  t3ThreadId: string,
  discordThreadId: string,
): Promise<void> {
  const dataDir = discordBotDataDir();
  const existing = await readDiscordPostThreadStore(dataDir);
  if (!existing.ok) throw discordPostThreadMapFailure(existing.reason);
  const remaining = existing.threads.filter(
    (entry) => !(entry.t3ThreadId === t3ThreadId && entry.discordThreadId === discordThreadId),
  );
  await writeDiscordPostThreadStore(dataDir, remaining);
  const remembered = discordPostThreadMemory.get(t3ThreadId);
  if (remembered?.discordThreadId === discordThreadId) {
    discordPostThreadMemory.delete(t3ThreadId);
  }
}

async function deliverDiscordThreadMessage(input: {
  readonly token: string;
  readonly parentChannelId: string;
  readonly discordThreadId: string;
  readonly sideStore: boolean;
  readonly t3ThreadId: string;
  readonly guildId: string;
  readonly title: string;
  readonly body: ReturnType<typeof buildDiscordCreateMessageBody>;
  readonly files: ReadonlyArray<DiscordUploadFile>;
}): Promise<{ readonly message: DiscordMessageResponse; readonly discordThreadId: string }> {
  const destination = assertDiscordThreadDestination(input.discordThreadId, input.parentChannelId);
  try {
    const message = await createDiscordMessage({
      token: input.token,
      channelId: destination,
      body: input.body,
      files: input.files,
    });
    return { message, discordThreadId: destination };
  } catch (error) {
    if (!input.sideStore || !isUnknownDiscordChannel(error)) throw error;
    const replacement = await withDiscordPostThreadLock(async () => {
      await forgetDiscordPostThreadUnlocked(input.t3ThreadId, destination);
      return ensureDiscordPostThreadUnlocked({
        token: input.token,
        t3ThreadId: input.t3ThreadId,
        channelId: input.parentChannelId,
        guildId: input.guildId,
        title: input.title,
      });
    });
    const next = assertDiscordThreadDestination(replacement.discordThreadId, input.parentChannelId);
    const message = await createDiscordMessage({
      token: input.token,
      channelId: next,
      body: input.body,
      files: input.files,
    });
    return { message, discordThreadId: next };
  }
}

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

const discordPostFailure = (
  message: string,
  code: "invalid_request" | "thread_not_found" | "orchestration_error" = "orchestration_error",
) => new OrchestratorMcpFailure({ code, message });

const DiscordPostSkipped = Schema.Struct({
  skipped: Schema.Literal(true),
  reason: Schema.Literal("not-discord-linked"),
  summary: Schema.String,
});

const DiscordPostDelivered = Schema.Struct({
  skipped: Schema.Literal(false),
  shortName: Schema.String,
  guildId: Schema.String,
  guildName: Schema.String,
  channelId: Schema.String,
  channelName: Schema.String,
  destinationId: Schema.String,
  discordThreadId: Schema.String,
  messageId: Schema.String,
  attachmentCount: Schema.Int,
  summary: Schema.String,
});

const DiscordPostTool = Tool.make("discord_post_to_linked_channel", {
  description:
    "Post into the Discord thread linked to the active T3 thread. T3 threads with no Discord link are skipped unless T3_DISCORD_POST_UNLINKED_THREADS is enabled. When that flag is enabled and there is no Discord thread yet, open a public thread in the repository channel (named from the T3 title) and post there. Never posts a top-level channel message. The repository channel is chosen by an `omegent-link-github:<org>/<repo>` topic tag (`omegent-link-<shortName>` and legacy `t3-<shortName>` still match). Supports file attachments, rich embeds, and polls.",
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService,
    ProjectStoreV2,
    RepositoryIdentityResolver,
  ],
  parameters: Schema.Struct({
    content: Schema.optional(Schema.String).annotate({ description: "Plain message content." }),
    attachments: Schema.optional(
      Schema.Array(
        Schema.Struct({
          path: Schema.String,
          filename: Schema.optional(Schema.String),
          description: Schema.optional(Schema.String),
          spoiler: Schema.optional(Schema.Boolean),
        }),
      ),
    ).annotate({
      description:
        "Local files to upload. Relative paths resolve from the current thread workspace.",
    }),
    embeds: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))).annotate({
      description:
        "Discord rich embeds. Uploaded files can be referenced with attachment://filename URLs.",
    }),
    poll: Schema.optional(
      Schema.Struct({
        question: Schema.String,
        answers: Schema.Array(Schema.String),
        durationHours: Schema.optional(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 768 })),
        ),
        allowMultiselect: Schema.optional(Schema.Boolean),
      }),
    ),
    replyToMessageId: Schema.optional(Schema.String),
    tts: Schema.optional(Schema.Boolean),
    suppressEmbeds: Schema.optional(Schema.Boolean),
    suppressNotifications: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Union([DiscordPostSkipped, DiscordPostDelivered]),
})
  .annotate(Tool.Title, "Post to linked Discord thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const DiscordLinkedChannelToolkit = Toolkit.make(DiscordPostTool);

const postToLinkedDiscordChannel = Effect.fn("DiscordLinkedChannelTool.post")(function* (
  input: DiscordPostToolInput,
) {
  const validationError = validateDiscordPostToolInput(input);
  if (validationError) {
    return yield* discordPostFailure(validationError, "invalid_request");
  }

  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const threadId = invocation.thread?.threadId;
  if (threadId === undefined) {
    return yield* discordPostFailure(
      "Discord posting needs an agent running inside a T3 thread.",
      "thread_not_found",
    );
  }

  const snapshotQuery = yield* ThreadManagementService;
  const threadShell = yield* snapshotQuery
    .getThreadShell(threadId)
    .pipe(Effect.map(Option.fromNullishOr));
  if (Option.isNone(threadShell)) {
    return yield* discordPostFailure(`Thread ${threadId} was not found.`, "thread_not_found");
  }

  const activeLink = yield* Effect.promise(() => lookupActiveLinkedDiscordThread(threadId));
  if (activeLink.status === "unreadable") {
    return yield* discordPostFailure(DISCORD_LINKS_UNREADABLE_MESSAGE);
  }
  const unlinkedPostsEnabled = yield* Effect.promise(() => resolveUnlinkedDiscordPostsEnabled());
  const decision = decideDiscordPost({
    linkedDiscordThreadId: activeLink.discordThreadId,
    unlinkedPostsEnabled,
  });
  if (decision.action === "skip") {
    return {
      skipped: true as const,
      reason: "not-discord-linked" as const,
      summary: SKIPPED_NOT_DISCORD_LINKED_SUMMARY,
    };
  }

  const projects = yield* ProjectStoreV2;
  const projectShell = yield* projects.get(threadShell.value.projectId);
  if (Option.isNone(projectShell)) {
    return yield* discordPostFailure(
      `Project ${threadShell.value.projectId} was not found for this thread.`,
      "invalid_request",
    );
  }

  const token = yield* Effect.promise(() => resolveDiscordBotToken());
  if (!token) {
    return yield* discordPostFailure(
      "Discord posting is unavailable because no Discord bot token is configured.",
    );
  }

  const repositoryIdentities = yield* RepositoryIdentityResolver;
  const identity = yield* repositoryIdentities.resolve(projectShell.value.workspaceRoot);
  const linkedChannel = yield* Effect.promise(() =>
    resolveLinkedChannel({
      token,
      workspaceRoot: projectShell.value.workspaceRoot,
      repositories: githubRepositoryRefsOf(identity),
    }),
  );
  if (linkedChannel === null) {
    return yield* discordPostFailure(
      `No linked Discord channel was found for repository workspace '${projectShell.value.workspaceRoot}'.`,
      "invalid_request",
    );
  }

  const cwd = threadShell.value.worktreePath ?? projectShell.value.workspaceRoot;
  const files = yield* Effect.promise(() => readDiscordUploadFiles(input.attachments ?? [], cwd));
  const body = buildDiscordCreateMessageBody(input, files);
  const opened =
    decision.action === "post"
      ? {
          discordThreadId: decision.discordThreadId,
          sideStore: false,
        }
      : yield* Effect.promise(() =>
          withDiscordPostThreadLock(() =>
            ensureDiscordPostThreadUnlocked({
              token,
              t3ThreadId: threadId,
              channelId: linkedChannel.channelId,
              guildId: linkedChannel.guildId,
              title: threadShell.value.title,
            }),
          ),
        );
  const delivered = yield* Effect.promise(() =>
    deliverDiscordThreadMessage({
      token,
      parentChannelId: linkedChannel.channelId,
      discordThreadId: opened.discordThreadId,
      sideStore: opened.sideStore,
      t3ThreadId: threadId,
      guildId: linkedChannel.guildId,
      title: threadShell.value.title,
      body,
      files,
    }),
  );

  return {
    skipped: false as const,
    shortName: linkedChannel.shortName,
    guildId: linkedChannel.guildId,
    guildName: linkedChannel.guildName,
    channelId: linkedChannel.channelId,
    channelName: linkedChannel.channelName,
    destinationId: delivered.discordThreadId,
    discordThreadId: delivered.discordThreadId,
    messageId: delivered.message.id,
    attachmentCount: delivered.message.attachments?.length ?? 0,
    summary: `Posted to a Discord thread in ${linkedChannel.guildName}/#${linkedChannel.channelName}.`,
  };
});

export const layer = McpToolAccess.toLayer(DiscordLinkedChannelToolkit, {
  discord_post_to_linked_channel: McpToolAccess.actsAsCaller((input) =>
    postToLinkedDiscordChannel(input).pipe(
      Effect.catchCause((cause) => {
        const failure = Cause.findErrorOption(cause);
        if (Option.isSome(failure) && isOrchestratorMcpFailure(failure.value)) {
          return Effect.fail(failure.value);
        }
        return Effect.fail(discordPostFailure(messageFromUnknown(Cause.squash(cause))));
      }),
    ),
  ),
});

export const __testing = {
  extractEnvAssignment,
  parseTopicShortName,
  pickLinkedDiscordChannel,
  pickLinkedDiscordThreadId,
  pickActiveLinkedDiscordThreadId,
  unlinkedDiscordPostsEnabledFrom,
  decideDiscordPost,
  discordThreadNameFromTitle,
  buildDiscordPublicThreadBody,
  parseDiscordPostThreadStore,
  readDiscordPostThreadStore,
  writeDiscordPostThreadStore,
  pickStoredDiscordPostThread,
  planStoredDiscordPostThread,
  lookupActiveLinkedDiscordThread,
  activeDiscordLinkFromFile,
  persistDiscordPostThreadRecord,
  saveCreatedDiscordPostThread,
  rememberedDiscordPostThread,
  rememberedDiscordPostThreadId,
  clearDiscordPostThreadMemory,
  ensureDiscordPostThreadUnlocked,
  assertDiscordThreadDestination,
  discordThreadIdFromCreateResponse,
  isUnknownDiscordChannel,
  buildDiscordMultipartForm,
  SKIPPED_NOT_DISCORD_LINKED_SUMMARY,
};
