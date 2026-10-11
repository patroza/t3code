import * as Data from "effect/Data";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { DiscordBotConfig } from "../config.ts";
import type { ProjectAliasStore } from "../projectAliases.ts";
import type { ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import type { T3Session } from "../t3/T3Session.ts";

export interface BotAction {
  readonly command: "stop" | "continue" | "approve" | "deny";
  readonly threadId: string;
  readonly requestId?: string;
  readonly label: string;
}

export interface BotMessageFields {
  readonly content: string;
  /** An empty list explicitly removes controls from an existing message. */
  readonly actions?: ReadonlyArray<BotAction>;
}

export interface BotMessage {
  readonly id: string;
  readonly content: string;
  readonly author?: { readonly id: string } | undefined;
  readonly timestamp?: string | undefined;
}

export interface BotConversation {
  readonly id: string;
  readonly name?: string | null | undefined;
  readonly topic?: string | null | undefined;
  readonly type: number;
  readonly parent_id?: string | null | undefined;
}

export interface BotUploadFile {
  readonly name: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
}

export interface BotThreadInfoInput {
  readonly conversationId: string;
  readonly threadId: string;
  readonly config: DiscordBotConfig;
  readonly incomingJiraKeys?: ReadonlyArray<string>;
  readonly dropJiraIssueKeys?: ReadonlyArray<string>;
  readonly incomingSentryIssueUrls?: ReadonlyArray<string>;
  readonly incomingPrUrls?: ReadonlyArray<string>;
  readonly modelSelection?: { readonly instanceId: string; readonly model: string } | null;
  readonly worktreePath?: string | null;
  readonly baseBranchLabel?: string | null;
  readonly local?: boolean;
  readonly skipChannelRepoLookup?: boolean;
  readonly extraLines?: ReadonlyArray<string | null | undefined>;
  readonly titleLine?: string | null;
}

type Request<A> = Effect.Effect<A, Error>;

/** Platform I/O only. Delivery epochs, statistics, streaming and recovery live in ResponseBridge. */
export interface BotResponseTransportService {
  readonly platform: "discord" | "teams";
  readonly config: DiscordBotConfig;
  readonly normalizeContent: (content: string) => string;
  readonly contentLimit: number;
  readonly fileLimit: number;
  readonly uploadLimitBytes: number;
  readonly getMyUser: () => Request<{ readonly id: string }>;
  readonly getChannel: (conversationId: string) => Request<BotConversation>;
  readonly getMessage: (conversationId: string, messageId: string) => Request<BotMessage>;
  readonly listMessages: (
    conversationId: string,
    options?: { readonly limit?: number; readonly before?: string; readonly after?: string },
  ) => Request<ReadonlyArray<BotMessage>>;
  readonly createMessage: (conversationId: string, fields: BotMessageFields) => Request<BotMessage>;
  readonly updateMessage: (
    conversationId: string,
    messageId: string,
    fields: BotMessageFields,
  ) => Request<BotMessage>;
  readonly deleteMessage: (conversationId: string, messageId: string) => Request<void>;
  readonly updateChannel: (
    conversationId: string,
    fields: { readonly name: string },
  ) => Request<unknown>;
  readonly createMessageWithFiles: (
    conversationId: string,
    content: string,
    files: ReadonlyArray<BotUploadFile>,
  ) => Request<{ readonly id: string }>;
  readonly upsertThreadInfo: (
    input: BotThreadInfoInput,
  ) => Effect.Effect<unknown, Error, ThreadLinkStore | ProjectAliasStore | T3Session>;
}

export class BotResponseTransport extends Context.Service<
  BotResponseTransport,
  BotResponseTransportService
>()("@t3tools/discord-bot/features/BotResponseTransport") {}

export const workingFields = (content: string, threadId: string): BotMessageFields => ({
  content,
  actions: [{ command: "stop", threadId, label: "Stop" }],
});

export const wakeUpFields = (content: string, threadId: string): BotMessageFields => ({
  content,
  actions: [{ command: "continue", threadId, label: "Continue" }],
});

export const idleFields = (content: string): BotMessageFields => ({ content, actions: [] });

export class BotTransportError extends Data.TaggedError("BotTransportError")<{
  readonly cause: unknown;
}> {}
