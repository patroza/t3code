// @effect-diagnostics globalPromise:off globalFetch:off nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
import type { DiscordBotConfig } from "../config.ts";
import * as Effect from "effect/Effect";
import * as NodeBuffer from "node:buffer";
import {
  BotTransportError,
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
import { ThreadLinkStore } from "../store/ThreadLinkStore.ts";

export interface TeamsResponseActivity {
  readonly type: "message";
  readonly id?: string;
  readonly text: string;
  readonly attachments?: Array<{
    contentType: string;
    content?: unknown;
    contentUrl?: string;
    name?: string;
  }>;
}

export function teamsMessageFields(fields: BotMessageFields): TeamsResponseActivity {
  return {
    type: "message",
    text: fields.content,
    attachments: fields.actions?.length
      ? [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              type: "AdaptiveCard",
              version: "1.4",
              body: [],
              actions: fields.actions.map((action) => ({
                type: "Action.Execute",
                title: action.label,
                verb: "omegent",
                data: { action: "omegent", ...action },
              })),
            },
          },
        ]
      : [],
  };
}

/** Graph history is essential for the shared bridge's timeout recovery and deduplication. */
export function teamsHistoryMarkdown(content: string): string {
  return content
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gisu, "[$2]($1)")
    .replace(/<br\s*\/?\s*>/giu, "\n")
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
  return teamsHistoryMarkdown(content).replace(/[*_`]/gu, "").replace(/\s+/gu, " ").trim();
}
export function graphMessage(message: {
  id: string;
  body?: { content?: string };
  from?: { application?: { id?: string }; user?: { id?: string } };
  createdDateTime?: string;
}): BotMessage {
  return {
    id: message.id,
    content: teamsHistoryMarkdown(message.body?.content ?? ""),
    ...(message.from?.application?.id || message.from?.user?.id
      ? { author: { id: message.from.application?.id ?? message.from.user!.id! } }
      : {}),
    ...(message.createdDateTime ? { timestamp: message.createdDateTime } : {}),
  };
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
  readonly assertActive: () => void;
  readonly send: (activity: TeamsResponseActivity) => Promise<{ id: string }>;
  readonly deleteMessage: (messageId: string) => Promise<unknown>;
  readonly fetch?: typeof globalThis.fetch;
}): BotResponseTransportService {
  const fetch = input.fetch ?? globalThis.fetch;
  const ownMessages = new Map<string, BotMessage>();
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
  const graph = async (url: string) => {
    input.assertActive();
    if (!url.startsWith(graphBase)) throw new Error("Unexpected Teams history URL");
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
    input.assertActive();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token.value}` },
    });
    if (!response.ok) throw new Error(`Teams history read failed (${response.status})`);
    return response.json();
  };
  const send = async (
    fields: BotMessageFields,
    id?: string,
    attachments?: TeamsResponseActivity["attachments"],
  ) => {
    input.assertActive();
    const wire = teamsMessageFields(fields);
    const sent = await input.send({
      ...wire,
      ...(id ? { id } : {}),
      ...(attachments ? { attachments } : {}),
    });
    const message: BotMessage = {
      id: sent.id || id!,
      content: fields.content,
      author: { id: input.clientId },
      timestamp: ownMessages.get(id ?? "")?.timestamp ?? new Date().toISOString(),
    };
    ownMessages.set(message.id, message);
    return message;
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
    getChannel: (id) => Effect.succeed({ id, type: 0, topic: "omegent-ips" }),
    updateChannel: () => Effect.void,
    getMessage: (_, id) =>
      request(
        async () =>
          ownMessages.get(id) ??
          graphMessage(
            await graph(
              id === input.rootMessageId
                ? graphBase
                : `${graphBase}/replies/${encodeURIComponent(id)}`,
            ),
          ),
      ),
    listMessages: (_, options) =>
      request(async () => {
        const found = new Map<string, BotMessage>();
        let url: string | undefined = `${graphBase}/replies?$top=50`;
        // A bounded history window covers the bridge's 15/25-message reconciliation scans.
        while (url) {
          const body = (await graph(url)) as {
            value: Array<Parameters<typeof graphMessage>[0]>;
            "@odata.nextLink"?: string;
          };
          for (const row of body.value) found.set(row.id, graphMessage(row));
          url = body["@odata.nextLink"];
        }
        for (const [id, message] of ownMessages) {
          const remote = found.get(id);
          found.set(id, remote?.timestamp ? { ...message, timestamp: remote.timestamp } : message);
        }
        return [...found.values()]
          .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
          .filter(
            (message) =>
              (!options?.before || message.id < options.before) &&
              (!options?.after || message.id > options.after),
          )
          .slice(0, options?.limit ?? 25);
      }),
    createMessage: (_, fields) => request(() => send(fields)),
    updateMessage: (_, id, fields) => request(() => send(fields, id)),
    deleteMessage: (_, id) =>
      request(async () => {
        await input.deleteMessage(id);
        ownMessages.delete(id);
      }),
    createMessageWithFiles: (_, content, files) =>
      request(async () => {
        const images = files.filter((file) => file.mimeType.startsWith("image/"));
        const other = files.filter((file) => !file.mimeType.startsWith("image/"));
        // Teams channel file uploads require SharePoint permissions. Keep this limitation visible.
        const note = other.length
          ? `\n\nChannel file upload is unavailable: ${other.map((file) => file.name).join(", ")}. Open the linked T3 thread for source attachments; generated delivery files could not be uploaded.`
          : "";
        return send(
          { content: content + note },
          undefined,
          images.map((file) => ({
            contentType: file.mimeType,
            name: file.name,
            contentUrl: `data:${file.mimeType};base64,${NodeBuffer.Buffer.from(file.data).toString("base64")}`,
          })),
        );
      }),
    upsertThreadInfo: (info) =>
      Effect.gen(function* () {
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
            webLink: info.config.webUiBaseUrl
              ? `${info.config.webUiBaseUrl.replace(/\/$/u, "")}/?thread=${info.threadId}`
              : null,
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
