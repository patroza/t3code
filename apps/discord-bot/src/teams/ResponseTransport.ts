// @effect-diagnostics globalPromise:off globalFetch:off nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
import { buildWebThreadUrl } from "@t3tools/shared/webThreadUrl";

import type { DiscordBotConfig } from "../config.ts";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as NodeBuffer from "node:buffer";
import * as NodeTimersPromises from "node:timers/promises";
import { uploadTeamsChannelFiles, type TeamsFileDestination } from "./channelFiles.ts";
import {
  BotTransportError,
  messageUpdateError,
  type BotMessage,
  type BotMessageFields,
  type BotResponseTransportService,
} from "../features/BotResponseTransport.ts";
import { buildThreadInfoRenderInput, modelHistoryFromLink } from "../features/ThreadInfoPin.ts";
import {
  applyModelHistoryUpdate,
  formatModelSelectionLine,
  renderThreadInfoPin,
} from "../presentation/threadInfoPin.ts";
import { extractMarkdownTables } from "../presentation/markdownTables.ts";
import { ThreadLinkStore } from "../store/ThreadLinkStore.ts";

const ledgerRow = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  author: Schema.optional(Schema.Struct({ id: Schema.String })),
  timestamp: Schema.optional(Schema.String),
  controlId: Schema.optional(Schema.String),
  controlKey: Schema.optional(Schema.String),
});
type TrackedMessage = typeof ledgerRow.Type;
const decodeLedgerRow = Schema.decodeUnknownSync(ledgerRow);

const visibleMessage = (message: TrackedMessage): BotMessage => ({
  id: message.id,
  content: message.content,
  ...(message.author ? { author: message.author } : {}),
  ...(message.timestamp ? { timestamp: message.timestamp } : {}),
});

export interface TeamsResponseActivity {
  readonly type: "message";
  readonly id?: string;
  readonly text: string;
  readonly textFormat: "extendedmarkdown";
  readonly attachments?: Array<{
    contentType: string;
    content?: unknown;
    contentUrl?: string;
    name?: string;
  }>;
}

const teamsControlCard = (actions: NonNullable<BotMessageFields["actions"]>) => ({
  contentType: "application/vnd.microsoft.card.adaptive",
  content: {
    type: "AdaptiveCard",
    version: "1.4",
    body: [],
    actions: actions.map((action) => ({
      type: "Action.Execute",
      title: action.label,
      verb: "omegent",
      data: { action: "omegent", ...action },
    })),
  },
});

const controlKey = (fields: BotMessageFields) =>
  JSON.stringify(
    (fields.actions ?? []).map((action) => [
      action.command,
      action.threadId,
      action.requestId ?? "",
      action.label,
    ]),
  );

// Teams splits an activity that contains both text and an attachment into two
// activities and returns only one id, so the card cannot be updated or deleted.
// Working text stays text-only. Stop and Continue are a second activity.
export function teamsMessageFields(fields: BotMessageFields): TeamsResponseActivity {
  return {
    type: "message",
    textFormat: "extendedmarkdown",
    text: fields.content,
    attachments: [],
  };
}

export function teamsControlActivity(fields: BotMessageFields): TeamsResponseActivity | null {
  if (!fields.actions?.length) return null;
  return {
    type: "message",
    textFormat: "extendedmarkdown",
    text: "",
    attachments: [teamsControlCard(fields.actions)],
  };
}

/** Graph history is essential for the shared bridge's timeout recovery and deduplication. */
export function teamsHistoryMarkdown(content: string): string {
  return content
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gisu, "[$2]($1)")
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(/<\/t[hd]>/giu, " ")
    .replace(/<\/tr>/giu, "\n")
    .replace(/<\/(?:p|div)>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&")
    .trim();
}
export function normalizeTeamsContent(content: string): string {
  // Graph returns native tables as HTML; compare their cells with the original Markdown
  // so an accepted send can be recovered without posting a duplicate after a timeout.
  for (const table of extractMarkdownTables(content).toReversed()) {
    content =
      content.slice(0, table.start) +
      [...table.headers, ...table.rows.flat()].join(" ") +
      content.slice(table.end);
  }
  return teamsHistoryMarkdown(content)
    .replace(/(\*\*|__)(.*?)\1/gsu, "$2")
    .replace(/(?<!\w)[*_]([^*_]+)[*_](?!\w)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}
export function graphMessage(message: {
  id: string;
  body?: { content?: string };
  from?: { application?: { id?: string }; user?: { id?: string } };
  createdDateTime?: string;
  attachments?: Array<{ contentType?: string; content?: string }>;
}): BotMessage {
  return {
    id: message.id,
    content: [
      teamsHistoryMarkdown(message.body?.content ?? ""),
      ...(message.attachments ?? []).flatMap((attachment) => {
        if (
          attachment.contentType !== "application/vnd.microsoft.card.adaptive" ||
          !attachment.content
        )
          return [];
        try {
          const card = JSON.parse(attachment.content) as {
            body?: Array<{ type?: string; text?: string }>;
          };
          return (card.body ?? []).flatMap((element) =>
            element.type === "TextBlock" && typeof element.text === "string" ? [element.text] : [],
          );
        } catch {
          return [];
        }
      }),
    ]
      .filter(Boolean)
      .join("\n\n"),
    ...(message.from?.application?.id || message.from?.user?.id
      ? { author: { id: message.from.application?.id ?? message.from.user!.id! } }
      : {}),
    ...(message.createdDateTime ? { timestamp: message.createdDateTime } : {}),
  };
}

/** A card-only Stop/Continue activity has no prose. Channel history must not treat it as a reply. */
function isTeamsControlActivity(message: {
  body?: { content?: string };
  attachments?: ReadonlyArray<{ contentType?: string; content?: string }>;
}): boolean {
  if (teamsHistoryMarkdown(message.body?.content ?? "").trim() !== "") return false;
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return false;
  return attachments.every((attachment) => {
    if (attachment.contentType !== "application/vnd.microsoft.card.adaptive" || !attachment.content)
      return false;
    try {
      const card = JSON.parse(attachment.content) as {
        body?: Array<{ type?: string; text?: string }>;
      };
      return (card.body ?? []).every(
        (element) =>
          element.type !== "TextBlock" ||
          typeof element.text !== "string" ||
          element.text.trim() === "",
      );
    } catch {
      return false;
    }
  });
}

export function makeTeamsResponseTransport(input: {
  readonly config: DiscordBotConfig;
  readonly clientId: string;
  readonly tenantId: string;
  readonly clientSecret: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly rootMessageId: string;
  readonly incomingMessage?: BotMessage;
  readonly fileDestination?: TeamsFileDestination | undefined;
  readonly includeProgressHistory?: boolean | undefined;
  readonly getChannelTopic?: (() => Promise<string>) | undefined;
  readonly assertActive: () => void;
  readonly send: (activity: TeamsResponseActivity) => Promise<{ id?: string }>;
  readonly deleteMessage: (messageId: string) => Promise<unknown>;
  readonly fetch?: typeof globalThis.fetch;
}): BotResponseTransportService {
  const fetch = input.fetch ?? globalThis.fetch;
  const dataDir = input.config.dataDir.startsWith("~/")
    ? NodePath.join(NodeOS.homedir(), input.config.dataDir.slice(2))
    : input.config.dataDir;
  const ledgerDir = NodePath.join(dataDir, "teams-response-ledger");
  NodeFS.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
  const ledgerPath = NodePath.join(
    ledgerDir,
    NodeCrypto.createHash("sha256").update(input.conversationId).digest("hex") + ".json",
  );
  const writeLedger = (rows: ReadonlyArray<TrackedMessage>) => {
    const temporary = ledgerPath + ".tmp";
    NodeFS.writeFileSync(temporary, JSON.stringify(rows), { mode: 0o600 });
    NodeFS.renameSync(temporary, ledgerPath);
  };
  const readLedger = () => {
    if (!NodeFS.existsSync(ledgerPath)) return new Map<string, TrackedMessage>();
    const original = NodeFS.readFileSync(ledgerPath, "utf8");
    const parsed: unknown = JSON.parse(original);
    if (!Array.isArray(parsed)) throw new Error("Teams delivery ledger must be an array");
    const rows = parsed.flatMap((row) => {
      try {
        const message = decodeLedgerRow(row);
        return message.id.trim() ? [message] : [];
      } catch {
        return [];
      }
    });
    if (rows.length !== parsed.length) {
      // Retain the original privately, but never let an invalid row poison later accepted sends.
      const digest = NodeCrypto.createHash("sha256").update(original).digest("hex");
      NodeFS.writeFileSync(ledgerPath + ".invalid-" + digest, original, { mode: 0o600 });
      writeLedger(rows);
    }
    return new Map<string, TrackedMessage>(rows.map((message) => [message.id, message]));
  };
  const ownMessages = readLedger();
  const persist = (message?: TrackedMessage, deletedId?: string) => {
    const current = readLedger();
    if (message) {
      if (typeof message.id !== "string" || !message.id.trim())
        throw new Error("Teams delivery requires a nonempty activity ID");
      current.set(message.id, message);
    }
    if (deletedId) current.delete(deletedId);
    const rows = [...current.values()]
      .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
      .slice(0, 500);
    writeLedger(rows);
  };
  if (input.incomingMessage) {
    ownMessages.set(input.incomingMessage.id, input.incomingMessage);
    persist(input.incomingMessage);
  }
  const channelHistory = !!input.teamId && !!input.channelId;
  let token: { value: string; expires: number } | null = null;
  const request = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        input.assertActive();
        return run();
      },
      catch: (cause) => new BotTransportError({ cause }),
    });
  const graphBase = `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(input.teamId)}/channels/${encodeURIComponent(input.channelId)}/messages/${encodeURIComponent(input.rootMessageId)}`;
  const getAccessToken = async () => {
    input.assertActive();
    if (!token || token.expires < Date.now() + 60_000) {
      const response = await fetch(
        `https://login.microsoftonline.com/${encodeURIComponent(input.tenantId)}/oauth2/v2.0/token`,
        {
          method: "POST",
          body: new URLSearchParams({
            client_id: input.clientId,
            client_secret: input.clientSecret,
            grant_type: "client_credentials",
            scope: "https://graph.microsoft.com/.default",
          }),
        },
      );
      if (!response.ok) throw new Error(`Teams history authentication failed (${response.status})`);
      const body = (await response.json()) as { access_token: string; expires_in: number };
      token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    }
    return token.value;
  };
  const graph = async (url: string) => {
    input.assertActive();
    if (!url.startsWith(graphBase)) throw new Error("Unexpected Teams history URL");
    const accessToken = await getAccessToken();
    input.assertActive();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Teams history read failed (${response.status})`);
    return response.json();
  };
  const deleteControl = async (controlId: string) => {
    try {
      await input.deleteMessage(controlId);
    } catch (cause) {
      if (messageUpdateError(cause).reason !== "message-not-found") throw cause;
    }
  };
  const syncControl = async (fields: BotMessageFields, message: TrackedMessage) => {
    const control = teamsControlActivity(fields);
    if (!control) {
      if (!message.controlId) return message;
      await deleteControl(message.controlId);
      return {
        id: message.id,
        content: message.content,
        ...(message.author ? { author: message.author } : {}),
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      };
    }
    const nextKey = controlKey(fields);
    if (message.controlId && message.controlKey === nextKey) return message;
    if (message.controlId) {
      try {
        await input.send({ ...control, id: message.controlId });
        return { ...message, controlKey: nextKey };
      } catch (cause) {
        if (messageUpdateError(cause).reason !== "message-not-found") throw cause;
        // The tracked card is gone. Drop it before posting a replacement so a
        // stale Stop cannot sit beside the new one.
        await deleteControl(message.controlId);
      }
    }
    const posted = await input.send(control);
    const controlId = typeof posted?.id === "string" ? posted.id.trim() : "";
    if (!controlId || controlId === message.id) {
      throw new Error("Teams accepted the Stop control without its own activity ID");
    }
    return { ...message, controlId, controlKey: nextKey };
  };
  const send = async (
    fields: BotMessageFields,
    id?: string,
    attachments?: TeamsResponseActivity["attachments"],
  ) => {
    input.assertActive();
    const startedAt = Date.now();
    const wire = teamsMessageFields(fields);
    const sent = await input.send({
      ...wire,
      ...(id ? { id } : {}),
      ...(attachments ? { attachments } : {}),
    });
    // An edit keeps its original identity even when the connector omits the response ID.
    let messageId = id ?? (typeof sent?.id === "string" && sent.id.trim() ? sent.id : undefined);
    if (!messageId && channelHistory) {
      // A connector may accept a create without returning its ID. Adopt the unique fresh Graph
      // message rather than writing an idless ledger row or creating another visible reply.
      for (let attempt = 0; attempt < 3 && !messageId; attempt++) {
        if (attempt) await NodeTimersPromises.setTimeout(250);
        const history = await Effect.runPromise(
          service.listMessages(input.conversationId, { limit: 25 }),
        );
        const candidates = history.filter(
          (message) =>
            message.author?.id === input.clientId &&
            !ownMessages.has(message.id) &&
            Date.parse(message.timestamp ?? "") >= startedAt - 2_000 &&
            normalizeTeamsContent(message.content) === normalizeTeamsContent(fields.content),
        );
        if (candidates.length === 1) messageId = candidates[0]!.id;
      }
    }
    if (!messageId) throw new Error("Teams accepted the send without a recoverable activity ID");
    // Each inbound Teams message builds a new transport, while a running bridge
    // keeps updating through the transport it started with. The ledger is the
    // shared record of that activity's Stop card.
    const previous = id ? (ownMessages.get(id) ?? readLedger().get(id)) : undefined;
    const message: TrackedMessage = {
      id: messageId,
      content: fields.content,
      author: { id: input.clientId },
      timestamp: previous?.timestamp ?? new Date().toISOString(),
      ...(previous?.controlId ? { controlId: previous.controlId } : {}),
      ...(previous?.controlKey ? { controlKey: previous.controlKey } : {}),
    };
    // Remember the text before touching its control, so a failed card post can retry
    // against the same activity instead of leaving an untracked Stop card behind.
    ownMessages.set(message.id, message);
    persist(message);
    if (attachments) return visibleMessage(message);
    const next = await syncControl(fields, message);
    if (next !== message) {
      ownMessages.set(next.id, next);
      persist(next);
    }
    return visibleMessage(next);
  };
  const service: BotResponseTransportService = {
    platform: "teams",
    normalizeContent: normalizeTeamsContent,
    config: input.config,
    contentLimit: 20_000,
    fileLimit: 10,
    uploadLimitBytes: 4_000_000,
    getMyUser: () => Effect.succeed({ id: input.clientId }),
    // Teams topics and names belong to the channel; the bridge must never rename it per turn.
    getChannel: (id) =>
      request(async () => {
        input.assertActive();
        const description = await input.getChannelTopic?.();
        input.assertActive();
        const topic = [description, input.includeProgressHistory ? "omegent-ips" : ""]
          .filter(Boolean)
          .join("\n");
        return { id, type: 0, topic: topic || null };
      }),
    updateChannel: () => Effect.void,
    getMessage: (_, id) =>
      request(async () => {
        const known = channelHistory ? ownMessages.get(id) : readLedger().get(id);
        if (known) return visibleMessage(known);
        if (!channelHistory)
          throw new Error("Message is not present in the private Teams delivery ledger");
        return graphMessage(
          await graph(
            id === input.rootMessageId
              ? graphBase
              : `${graphBase}/replies/${encodeURIComponent(id)}`,
          ),
        );
      }),
    listMessages: (_, options) =>
      request(async () => {
        const found = channelHistory ? new Map<string, TrackedMessage>() : readLedger();
        let url: string | undefined = channelHistory ? `${graphBase}/replies?$top=50` : undefined;
        // Graph returns replies in oldest-first pages; read all pages before selecting the latest window.
        while (url) {
          const body = (await graph(url)) as {
            value: Array<Parameters<typeof graphMessage>[0]>;
            "@odata.nextLink"?: string;
          };
          for (const row of body.value) {
            if (isTeamsControlActivity(row)) continue;
            found.set(row.id, graphMessage(row));
          }
          url = body["@odata.nextLink"];
        }
        const controlIds = new Set(
          [...ownMessages.values()].flatMap((message) =>
            message.controlId ? [message.controlId] : [],
          ),
        );
        for (const [id, message] of channelHistory ? ownMessages : []) {
          const remote = found.get(id);
          found.set(id, remote?.timestamp ? { ...message, timestamp: remote.timestamp } : message);
        }
        return [...found.values()]
          .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
          .filter(
            (message) =>
              !controlIds.has(message.id) &&
              (!options?.before || message.id < options.before) &&
              (!options?.after || message.id > options.after),
          )
          .slice(0, options?.limit ?? 25)
          .map(visibleMessage);
      }),
    createMessage: (_, fields) => request(() => send(fields)),
    updateMessage: (_, id, fields) =>
      request(() => send(fields, id)).pipe(
        Effect.mapError((error) => messageUpdateError(error.cause)),
      ),
    deleteMessage: (_, id) =>
      request(async () => {
        const tracked = ownMessages.get(id) ?? readLedger().get(id);
        if (tracked?.controlId) await deleteControl(tracked.controlId);
        await input.deleteMessage(id);
        ownMessages.delete(id);
        persist(undefined, id);
      }).pipe(Effect.mapError((error) => messageUpdateError(error.cause))),
    createMessageWithFiles: (_, content, files) =>
      request(async () => {
        const images = files.filter((file) => file.mimeType.startsWith("image/"));
        const other = files.filter((file) => !file.mimeType.startsWith("image/"));
        const uploaded =
          input.fileDestination && other.length
            ? await uploadTeamsChannelFiles({
                destination: input.fileDestination,
                files: other,
                getAccessToken,
                assertActive: input.assertActive,
                fetch,
              })
            : [];
        const note =
          other.length && !input.fileDestination
            ? `\n\nFile upload is not configured for this channel: ${other.map((file) => file.name).join(", ")}. Open the linked T3 thread for source attachments; generated files could not be delivered.`
            : "";
        const attachments: NonNullable<TeamsResponseActivity["attachments"]> = images.map(
          (file) => ({
            contentType: file.mimeType,
            name: file.name,
            contentUrl: `data:${file.mimeType};base64,${NodeBuffer.Buffer.from(file.data).toString("base64")}`,
          }),
        );
        if (uploaded.length)
          attachments.unshift({
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              type: "AdaptiveCard",
              version: "1.4",
              body: [],
              actions: uploaded.map((file, index) => ({
                type: "Action.OpenUrl",
                title: other[index]!.name,
                url: file.webUrl,
              })),
            },
          });
        return send({ content: content + note }, undefined, attachments);
      }),
    upsertThreadInfo: Effect.fn("ResponseTransport.upsertThreadInfo")(function* (info) {
      const links = yield* ThreadLinkStore;
      const link = yield* links.getByDiscordThreadId(info.conversationId);
      const history = applyModelHistoryUpdate(
        modelHistoryFromLink(link),
        info.modelSelection ? formatModelSelectionLine(info.modelSelection) : null,
      );
      yield* links.setModelHistory(info.conversationId, history);
      const jira = [
        ...new Set([...(link?.jiraIssueKeys ?? []), ...(info.incomingJiraKeys ?? [])]),
      ].filter((key) => !info.dropJiraIssueKeys?.includes(key));
      const sentry = [
        ...new Set([...(link?.sentryIssueUrls ?? []), ...(info.incomingSentryIssueUrls ?? [])]),
      ];
      const prs = [...new Set([...(link?.prUrls ?? []), ...(info.incomingPrUrls ?? [])])];
      yield* links.setJiraIssueKeys(info.conversationId, jira);
      yield* links.setSentryIssueUrls(info.conversationId, sentry);
      yield* links.setPrUrls(info.conversationId, prs);
      const content = renderThreadInfoPin(
        buildThreadInfoRenderInput({
          ...info,
          modelHistory: history,
          webLink: buildWebThreadUrl(info.config.webUiBaseUrl, info.threadId),
          jiraIssueKeys: jira,
          sentryIssueUrls: sentry,
          prUrls: prs,
          jiraBrowseBaseUrl: info.config.jiraBrowseBaseUrl,
        }),
      );
      const old = link?.infoDiscordMessageId;
      const sent = old
        ? yield* service
            .updateMessage(info.conversationId, old, { content })
            .pipe(Effect.catch(() => service.createMessage(info.conversationId, { content })))
        : yield* service.createMessage(info.conversationId, { content });
      yield* links.setInfoDiscordMessageId(info.conversationId, sent.id);
    }),
  };
  return service;
}
