import { fetchMicrosoftAppToken } from "./inboundImages.ts";

/** Where a group chat's title came from, for the "not watched" log. */
export type GroupChatTitleSource = "activity" | "graph" | "none";

export interface GroupChatTitle {
  readonly title: string | undefined;
  readonly source: GroupChatTitleSource;
  /** Graph outcome when the activity had no title: `ok`, an HTTP status, or `error`. */
  readonly graph?: string | undefined;
}

const FOUND_TTL_MS = 60 * 60 * 1000;
const MISSING_TTL_MS = 10 * 60 * 1000;

/**
 * Teams often leaves `conversation.name` off group chat activities, and watched chats are matched
 * by title. Fills it from Graph `GET /chats/{id}` (topic), cached per chat.
 */
export function makeGroupChatTitleResolver(input: {
  readonly clientId: string;
  readonly clientSecret: () => string;
  readonly tokenCache: Map<string, { token: string; expiresAt: number }>;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly now?: () => number;
}) {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const now = input.now ?? Date.now;
  const cache = new Map<string, { readonly value: GroupChatTitle; readonly expiresAt: number }>();

  const lookup = async (tenantId: string, chatId: string): Promise<GroupChatTitle> => {
    const token = await fetchMicrosoftAppToken({
      tenantId,
      clientId: input.clientId,
      clientSecret: input.clientSecret(),
      scope: "https://graph.microsoft.com/.default",
      fetchImpl,
      cache: input.tokenCache,
    });
    if (token === null) return { title: undefined, source: "none", graph: "no-token" };
    let response: Response;
    try {
      response = await fetchImpl(
        `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}?$select=id,topic`,
        {
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Bearer ${token}` },
        },
      );
    } catch {
      return { title: undefined, source: "none", graph: "error" };
    }
    if (!response.ok) return { title: undefined, source: "none", graph: String(response.status) };
    const body = (await response.json().catch(() => null)) as { topic?: unknown } | null;
    const topic = typeof body?.topic === "string" ? body.topic.trim() : "";
    return topic.length > 0
      ? { title: topic, source: "graph", graph: "ok" }
      : { title: undefined, source: "none", graph: "no-topic" };
  };

  return async (activity: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly name: string | undefined;
  }): Promise<GroupChatTitle> => {
    const name = activity.name?.trim();
    if (name !== undefined && name.length > 0) return { title: name, source: "activity" };
    const chatId = activity.conversationId.split(";messageid=")[0] ?? activity.conversationId;
    const key = `${activity.tenantId}\n${chatId}`;
    const cached = cache.get(key);
    if (cached !== undefined && cached.expiresAt > now()) return cached.value;
    const value = await lookup(activity.tenantId, chatId);
    cache.set(key, {
      value,
      expiresAt: now() + (value.title === undefined ? MISSING_TTL_MS : FOUND_TTL_MS),
    });
    return value;
  };
}
