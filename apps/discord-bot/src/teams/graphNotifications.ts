// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalPromise:off globalErrorInErrorChannel:off
import * as NodeCrypto from "node:crypto";
import type { LoopbackRoute } from "./gatewayHttp.ts";
import type { GatewayActivity } from "./gatewayPolicy.ts";
import type { TeamsActivityAttachment } from "./inboundImages.ts";
import { teamsHtmlToText } from "./referencedMessages.ts";

const NOTIFICATION_BODY_MAX = 262_144;
const FILE_DOWNLOAD = "application/vnd.microsoft.teams.file.download.info";

export interface GraphChatMessageChange {
  readonly subscriptionId: string;
  readonly chatId: string;
  readonly messageId: string;
}
export interface GraphLifecycleEvent {
  readonly subscriptionId: string;
  readonly event: "reauthorizationRequired" | "subscriptionRemoved" | "missed";
}
export interface GraphNotificationBatch {
  readonly changes: ReadonlyArray<GraphChatMessageChange>;
  readonly lifecycle: ReadonlyArray<GraphLifecycleEvent>;
}

/** The subset of a Graph `chatMessage` the gateway reads. */
export interface GraphChatMessage {
  readonly id: string;
  readonly messageType?: string | null;
  readonly createdDateTime?: string | null;
  readonly deletedDateTime?: string | null;
  readonly chatId?: string | null;
  readonly from?: {
    readonly user?: { readonly id?: string | null; readonly displayName?: string | null } | null;
    readonly application?: { readonly id?: string | null } | null;
  } | null;
  readonly body?: { readonly contentType?: string | null; readonly content?: string | null } | null;
  readonly attachments?: ReadonlyArray<{
    readonly id?: string | null;
    readonly contentType?: string | null;
    readonly contentUrl?: string | null;
    readonly content?: string | null;
    readonly name?: string | null;
  }> | null;
  readonly mentions?: ReadonlyArray<{
    readonly id?: number | null;
    readonly mentioned?: {
      readonly application?: { readonly id?: string | null } | null;
      readonly user?: { readonly id?: string | null } | null;
    } | null;
  }> | null;
}

export function clientStateMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  const left = NodeCrypto.createHash("sha256").update(expected).digest();
  const right = NodeCrypto.createHash("sha256").update(actual).digest();
  return NodeCrypto.timingSafeEqual(left, right) && expected.length > 0;
}

/** `chats('19:..@thread.v2')/messages('1795..')`, with or without a leading slash or quotes. */
export function parseChatMessageResource(
  resource: unknown,
): { readonly chatId: string; readonly messageId: string } | null {
  if (typeof resource !== "string") return null;
  const match =
    /^\/?chats\('([^'()/]+)'\)\/messages\('([^'()/]+)'\)$/u.exec(resource) ??
    /^\/?chats\/([^/]+)\/messages\/([^/]+)$/u.exec(resource);
  if (match === null) return null;
  let chatId: string;
  let messageId: string;
  try {
    chatId = decodeURIComponent(match[1]!);
    messageId = decodeURIComponent(match[2]!);
  } catch {
    return null;
  }
  if (!chatId.startsWith("19:") || !/^\d+$/u.test(messageId)) return null;
  return { chatId, messageId };
}

/** Drops every item whose clientState does not match; an invalid batch is simply empty. */
export function parseGraphNotifications(
  body: unknown,
  clientState: string,
): GraphNotificationBatch {
  const changes: GraphChatMessageChange[] = [];
  const lifecycle: GraphLifecycleEvent[] = [];
  const value =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).value
      : null;
  for (const item of Array.isArray(value) ? value : []) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (!clientStateMatches(clientState, record.clientState)) continue;
    const subscriptionId = record.subscriptionId;
    if (typeof subscriptionId !== "string" || subscriptionId.length === 0) continue;
    const event = record.lifecycleEvent;
    if (event !== undefined) {
      if (
        event === "reauthorizationRequired" ||
        event === "subscriptionRemoved" ||
        event === "missed"
      )
        lifecycle.push({ subscriptionId, event });
      continue;
    }
    if (record.changeType !== "created") continue;
    const parsed = parseChatMessageResource(record.resource);
    if (parsed !== null) changes.push({ subscriptionId, ...parsed });
  }
  return { changes, lifecycle };
}

/**
 * `POST /api/graph/notifications`. Graph authenticates with the per-gateway clientState,
 * not a JWT, so this route stays outside the Teams SDK callback. Never logs content.
 */
export function graphNotificationRoute(input: {
  readonly clientState: string;
  readonly onNotifications: (batch: GraphNotificationBatch) => Promise<void>;
  readonly onError?: (reason: string) => void;
}): LoopbackRoute {
  return async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const validationToken = url.searchParams.get("validationToken");
    if (validationToken !== null) {
      request.resume();
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      });
      response.end(validationToken);
      return;
    }
    if (!/^application\/json(?:;|$)/iu.test(request.headers["content-type"] ?? "")) {
      request.resume();
      response.writeHead(415).end();
      return;
    }
    let size = 0;
    const parts: Buffer[] = [];
    for await (const part of request) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += bytes.length;
      if (size > NOTIFICATION_BODY_MAX) {
        response.writeHead(413).end();
        request.resume();
        return;
      }
      parts.push(bytes);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      response.writeHead(400).end();
      return;
    }
    const batch = parseGraphNotifications(body, input.clientState);
    // Graph wants an answer within seconds; reading messages happens after the response.
    response.writeHead(202).end();
    if (batch.changes.length === 0 && batch.lifecycle.length === 0) return;
    setImmediate(() => {
      input.onNotifications(batch).catch((error: unknown) => {
        input.onError?.(error instanceof Error ? error.name : "unknown");
      });
    });
  };
}

export type GraphMessageSkip = "not-a-message" | "deleted" | "from-application" | "no-author";

/**
 * A Graph chat message as the group-chat activity the bot path receives, so both share
 * the claim, routing and ingest. Teams uses the Graph message id as the activity id.
 */
export function graphChatMessageToActivity(
  message: GraphChatMessage,
  input: {
    readonly chatId: string;
    readonly tenantId: string;
    readonly botAppId: string;
    readonly serviceUrl: string;
  },
):
  | { readonly kind: "skip"; readonly reason: GraphMessageSkip }
  | {
      readonly kind: "activity";
      readonly activity: GatewayActivity & {
        readonly attachments: ReadonlyArray<TeamsActivityAttachment>;
      };
    } {
  if (message.messageType !== "message") return { kind: "skip", reason: "not-a-message" };
  if (message.deletedDateTime !== undefined && message.deletedDateTime !== null)
    return { kind: "skip", reason: "deleted" };
  const botAppId = input.botAppId.toLowerCase();
  const application = message.from?.application?.id;
  if (application !== undefined && application !== null)
    return { kind: "skip", reason: "from-application" };
  const user = message.from?.user;
  if (user?.id === undefined || user.id === null || user.id.length === 0)
    return { kind: "skip", reason: "no-author" };
  if (user.id.toLowerCase() === botAppId) return { kind: "skip", reason: "from-application" };

  const botMentionIds = new Set<number>();
  for (const mention of message.mentions ?? []) {
    if (mention.mentioned?.application?.id?.toLowerCase() === botAppId && mention.id != null)
      botMentionIds.add(mention.id);
  }
  const content = message.body?.content ?? "";
  const html = message.body?.contentType?.toLowerCase() !== "text";
  // The bot path strips its own mention (`stripText`), so the Graph path must too.
  const withoutBot = html
    ? content.replace(/<at\b[^>]*\bid\s*=\s*["']?(\d+)["']?[^>]*>[\s\S]*?<\/at>/giu, (tag, id) =>
        botMentionIds.has(Number(id)) ? "" : tag,
      )
    : content;
  const text = html ? teamsHtmlToText(withoutBot) : withoutBot.trim();

  const attachments: TeamsActivityAttachment[] = [];
  const quotes: string[] = [];
  for (const attachment of message.attachments ?? []) {
    const type = attachment.contentType ?? "";
    if (type === "reference") {
      attachments.push({ contentType: FILE_DOWNLOAD, name: attachment.name ?? "teams-file" });
    } else if (type === "messageReference") {
      const quoted = quotedMessageId(attachment.content);
      if (quoted !== null)
        quotes.push(
          `<blockquote itemtype="http://schema.skype.com/Reply" itemid="${quoted}"></blockquote>`,
        );
    } else if (type.startsWith("image/") && attachment.contentUrl) {
      attachments.push({
        contentType: type,
        contentUrl: attachment.contentUrl,
        ...(attachment.name ? { name: attachment.name } : {}),
      });
    } else if (type.startsWith("application/vnd.microsoft.card.")) {
      attachments.push({ contentType: type, content: attachment.content ?? null });
    }
  }
  // Quotes reach the reference loader the way the bot path's HTML attachment carries them.
  if (quotes.length > 0) attachments.push({ contentType: "text/html", content: quotes.join("") });

  const botId = "28:" + input.botAppId;
  return {
    kind: "activity",
    activity: {
      id: message.id,
      type: "message",
      channelId: "msteams",
      serviceUrl: input.serviceUrl,
      ...(message.createdDateTime ? { timestamp: message.createdDateTime } : {}),
      text,
      from: {
        aadObjectId: user.id,
        ...(user.displayName ? { name: user.displayName } : {}),
      },
      recipient: { id: botId },
      conversation: {
        id: input.chatId,
        tenantId: input.tenantId,
        conversationType: "groupChat",
        isGroup: true,
      },
      channelData: { tenant: { id: input.tenantId } },
      entities: botMentionIds.size > 0 ? [{ type: "mention", mentioned: { id: botId } }] : [],
      attachments,
    },
  };
}

function quotedMessageId(content: string | null | undefined): string | null {
  if (typeof content !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(content);
    const id =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).messageId
        : undefined;
    return typeof id === "string" && /^\d+$/u.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Runs tasks with the same key one after another, in submission order. */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<A>(key: string, task: () => Promise<A>): Promise<A> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
