// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalPromise:off globalFetch:off globalErrorInErrorChannel:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { TeamsGatewayConfig } from "./gatewayConfig.ts";
import type { GraphChatMessage } from "./graphNotifications.ts";
import { groupChatWorkspaceTarget } from "./groupChats.ts";
import { fetchMicrosoftAppToken } from "./inboundImages.ts";
import { teamsWeekBucket } from "./weeklyThreads.ts";

const GRAPH_ORIGIN = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
// Chat message subscriptions without resource data live at most 60 minutes.
const SUBSCRIPTION_LIFETIME_MS = 55 * 60_000;
const RENEW_BEFORE_EXPIRY_MS = 15 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
const CATCH_UP_LIMIT = 50;
// Gateway group-chat claims are kept 25 hours.
const FIRST_CATCH_UP_MAX_AGE_MS = 24 * 60 * 60_000;

export interface GraphResponse {
  /** 0 when the token or the request itself failed. */
  readonly status: number;
  readonly body: unknown;
}
export interface GraphClient {
  request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<GraphResponse>;
}

export function makeGraphClient(input: {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: () => string;
  readonly tokenCache: Map<string, { token: string; expiresAt: number }>;
  readonly fetch?: typeof globalThis.fetch;
}): GraphClient {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  return {
    request: async (method, path, body) => {
      const token = await fetchMicrosoftAppToken({
        tenantId: input.tenantId,
        clientId: input.clientId,
        clientSecret: input.clientSecret(),
        scope: GRAPH_SCOPE,
        fetchImpl,
        cache: input.tokenCache,
      });
      if (token === null) return { status: 0, body: null };
      try {
        const response = await fetchImpl(GRAPH_ORIGIN + path, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let parsed: unknown = null;
        try {
          parsed = text.length === 0 ? null : JSON.parse(text);
        } catch {
          parsed = null;
        }
        return { status: response.status, body: parsed };
      } catch {
        return { status: 0, body: null };
      }
    },
  };
}

interface ChatState {
  readonly subscriptionId?: string | undefined;
  readonly expiresAt?: number | undefined;
  readonly lastSeen?: string | undefined;
}

export type GraphSubscriptionLog = (
  level: "info" | "warning",
  message: string,
  fields: Record<string, unknown>,
) => void;

const chatPath = (chatId: string) => `/chats/${encodeURIComponent(chatId)}/messages`;
const short = (chatId: string) => chatId.slice(0, 24);
const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

function readClientState(file: string): string {
  try {
    const existing = NodeFS.readFileSync(file, "utf8").trim();
    if (existing.length > 0) return existing;
  } catch {
    /* first start */
  }
  const created = NodeCrypto.randomBytes(32).toString("base64url");
  NodeFS.writeFileSync(file, created, { mode: 0o600 });
  NodeFS.chmodSync(file, 0o600);
  return created;
}

/**
 * Keeps one Graph `created` subscription per pinned group chat and remembers the newest
 * message seen per chat. Failures are logged and retried with backoff; nothing throws.
 */
export class GraphChatSubscriptions {
  readonly clientState: string;
  private readonly graph: GraphClient;
  private readonly notificationUrl: string;
  private readonly now: () => number;
  private readonly log: GraphSubscriptionLog;
  private readonly statePath: string;
  private readonly chats: Map<string, ChatState>;
  private readonly desired: ReadonlySet<string>;
  private readonly retries = new Map<string, { at: number; failures: number }>();

  constructor(input: {
    readonly graph: GraphClient;
    readonly stateDir: string;
    readonly notificationUrl: string;
    readonly chatIds: ReadonlyArray<string>;
    readonly now?: () => number;
    readonly log: GraphSubscriptionLog;
  }) {
    this.graph = input.graph;
    this.notificationUrl = input.notificationUrl;
    this.now = input.now ?? Date.now;
    this.log = input.log;
    this.desired = new Set(input.chatIds);
    this.clientState = readClientState(
      NodePath.join(input.stateDir, "graph-notifications-client-state"),
    );
    this.statePath = NodePath.join(input.stateDir, "graph-subscriptions.json");
    this.chats = new Map();
    try {
      const parsed: unknown = JSON.parse(NodeFS.readFileSync(this.statePath, "utf8"));
      const rows =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).chats
          : null;
      if (rows !== null && typeof rows === "object" && !Array.isArray(rows)) {
        for (const [chatId, row] of Object.entries(rows as Record<string, unknown>)) {
          if (row === null || typeof row !== "object") continue;
          const value = row as Record<string, unknown>;
          this.chats.set(chatId, {
            ...(typeof value.subscriptionId === "string"
              ? { subscriptionId: value.subscriptionId }
              : {}),
            ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
            ...(typeof value.lastSeen === "string" ? { lastSeen: value.lastSeen } : {}),
          });
        }
      }
    } catch {
      /* no state yet */
    }
  }

  isWatched(chatId: string): boolean {
    return this.desired.has(chatId);
  }

  chatForSubscription(subscriptionId: string): string | undefined {
    for (const [chatId, state] of this.chats)
      if (state.subscriptionId === subscriptionId && this.desired.has(chatId)) return chatId;
    return undefined;
  }

  lastSeen(chatId: string): string | undefined {
    return this.chats.get(chatId)?.lastSeen;
  }

  /** Only ever moves forward, so out-of-order callers cannot rewind catch-up. */
  recordSeen(chatId: string, createdDateTime: string | Date | undefined): void {
    if (!this.desired.has(chatId) || createdDateTime === undefined) return;
    const iso =
      typeof createdDateTime === "string" ? createdDateTime : createdDateTime.toISOString();
    const at = time(iso);
    if (!Number.isFinite(at)) return;
    const state = this.chats.get(chatId) ?? {};
    if (state.lastSeen !== undefined && time(state.lastSeen) >= at) return;
    this.chats.set(chatId, { ...state, lastSeen: new Date(at).toISOString() });
    this.persist();
  }

  /**
   * Creates, renews and deletes subscriptions that are due. Returns the chats whose
   * subscription was (re)created, which may have missed messages in between.
   */
  async reconcile(): Promise<ReadonlyArray<string>> {
    const created: string[] = [];
    for (const [chatId, state] of this.chats) {
      if (this.desired.has(chatId) || state.subscriptionId === undefined) continue;
      if (!this.due(chatId)) continue;
      const response = await this.graph.request(
        "DELETE",
        `/subscriptions/${encodeURIComponent(state.subscriptionId)}`,
      );
      if ((response.status >= 200 && response.status < 300) || response.status === 404) {
        this.chats.delete(chatId);
        this.retries.delete(chatId);
        this.persist();
        this.log("info", "Deleted Graph subscription for unpinned chat", { chat: short(chatId) });
      } else this.fail(chatId, "delete", response.status);
    }
    for (const chatId of this.desired) {
      const state = this.chats.get(chatId);
      if (!this.due(chatId)) continue;
      if (state?.subscriptionId === undefined || state.expiresAt === undefined) {
        if (await this.create(chatId)) created.push(chatId);
      } else if (state.expiresAt - this.now() <= RENEW_BEFORE_EXPIRY_MS) {
        const renewed = await this.renew(chatId);
        if (renewed === "created") created.push(chatId);
      }
    }
    return created;
  }

  /** PATCH the expiry; a subscription Graph no longer knows is recreated. */
  async renew(chatId: string): Promise<"renewed" | "created" | "failed"> {
    const state = this.chats.get(chatId);
    if (!this.desired.has(chatId)) return "failed";
    if (state?.subscriptionId === undefined)
      return (await this.create(chatId)) ? "created" : "failed";
    const expiresAt = this.now() + SUBSCRIPTION_LIFETIME_MS;
    const response = await this.graph.request(
      "PATCH",
      `/subscriptions/${encodeURIComponent(state.subscriptionId)}`,
      { expirationDateTime: new Date(expiresAt).toISOString() },
    );
    if (response.status === 404) {
      this.chats.set(chatId, { ...state, subscriptionId: undefined, expiresAt: undefined });
      return (await this.create(chatId)) ? "created" : "failed";
    }
    if (response.status < 200 || response.status >= 300) {
      this.fail(chatId, "renew", response.status);
      return "failed";
    }
    this.chats.set(chatId, { ...state, expiresAt });
    this.retries.delete(chatId);
    this.persist();
    return "renewed";
  }

  async recreate(chatId: string): Promise<boolean> {
    if (!this.desired.has(chatId)) return false;
    const state = this.chats.get(chatId) ?? {};
    this.chats.set(chatId, { ...state, subscriptionId: undefined, expiresAt: undefined });
    return this.create(chatId);
  }

  private async create(chatId: string): Promise<boolean> {
    const expiresAt = this.now() + SUBSCRIPTION_LIFETIME_MS;
    const response = await this.graph.request("POST", "/subscriptions", {
      changeType: "created",
      resource: `/chats/${chatId}/messages`,
      notificationUrl: this.notificationUrl,
      lifecycleNotificationUrl: this.notificationUrl,
      expirationDateTime: new Date(expiresAt).toISOString(),
      clientState: this.clientState,
    });
    const body =
      response.body !== null && typeof response.body === "object"
        ? (response.body as Record<string, unknown>)
        : {};
    if (response.status !== 201 && response.status !== 200) {
      this.fail(chatId, "create", response.status);
      return false;
    }
    if (typeof body.id !== "string" || body.id.length === 0) {
      this.fail(chatId, "create", response.status);
      return false;
    }
    const returned = time(
      typeof body.expirationDateTime === "string" ? body.expirationDateTime : "",
    );
    this.chats.set(chatId, {
      ...this.chats.get(chatId),
      subscriptionId: body.id,
      expiresAt: Number.isFinite(returned) ? returned : expiresAt,
    });
    this.retries.delete(chatId);
    this.persist();
    this.log("info", "Created Graph subscription", { chat: short(chatId) });
    return true;
  }

  private readonly tenants = new Map<string, string>();

  /** The chat's own tenant, as Teams puts it in bot activities; null when Graph cannot say. */
  async chatTenant(chatId: string): Promise<string | null> {
    const cached = this.tenants.get(chatId);
    if (cached !== undefined) return cached;
    const response = await this.graph.request(
      "GET",
      `/chats/${encodeURIComponent(chatId)}?$select=tenantId`,
    );
    const tenant =
      response.status === 200 && response.body !== null && typeof response.body === "object"
        ? (response.body as Record<string, unknown>).tenantId
        : undefined;
    if (typeof tenant !== "string" || tenant.length === 0) {
      this.log("warning", "Graph chat tenant read failed", {
        chat: short(chatId),
        status: response.status,
      });
      return null;
    }
    this.tenants.set(chatId, tenant);
    return tenant;
  }

  async getMessage(chatId: string, messageId: string): Promise<GraphChatMessage | null> {
    const response = await this.graph.request(
      "GET",
      `${chatPath(chatId)}/${encodeURIComponent(messageId)}`,
    );
    if (response.status !== 200) {
      this.log("warning", "Graph chat message read failed", {
        chat: short(chatId),
        status: response.status,
      });
      return null;
    }
    return asMessage(response.body);
  }

  /**
   * Messages newer than the last one seen, oldest first; never more than 50. Without a
   * last-seen message the window starts on this week's Monday (UTC), but no earlier than the
   * intake claims reach back: older messages the bot already delivered would ingest twice.
   */
  async missedMessages(chatId: string): Promise<ReadonlyArray<GraphChatMessage> | null> {
    const response = await this.graph.request(
      "GET",
      `${chatPath(chatId)}?$top=${CATCH_UP_LIMIT}&$orderby=createdDateTime%20desc`,
    );
    if (response.status !== 200) {
      this.log("warning", "Graph chat catch-up failed", {
        chat: short(chatId),
        status: response.status,
      });
      return null;
    }
    const value =
      response.body !== null && typeof response.body === "object"
        ? (response.body as Record<string, unknown>).value
        : null;
    const messages = (Array.isArray(value) ? value : [])
      .map(asMessage)
      .filter((message): message is GraphChatMessage => message !== null);
    const seen = this.lastSeen(chatId);
    const after =
      seen === undefined
        ? Math.max(
            Date.parse(teamsWeekBucket(new Date(this.now()), "UTC").slice(5) + "T00:00:00.000Z") -
              1,
            this.now() - FIRST_CATCH_UP_MAX_AGE_MS,
          )
        : time(seen);
    return messages
      .filter((message) => time(message.createdDateTime) > after)
      .sort((left, right) => time(left.createdDateTime) - time(right.createdDateTime))
      .slice(-CATCH_UP_LIMIT);
  }

  private due(chatId: string): boolean {
    const retry = this.retries.get(chatId);
    return retry === undefined || retry.at <= this.now();
  }

  private fail(chatId: string, operation: string, status: number): void {
    const failures = (this.retries.get(chatId)?.failures ?? 0) + 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
    this.retries.set(chatId, { at: this.now() + delay, failures });
    this.log("warning", "Graph subscription request failed", {
      chat: short(chatId),
      operation,
      status,
      retryInSeconds: delay / 1000,
    });
  }

  private persist(): void {
    const temporary = this.statePath + ".tmp";
    NodeFS.writeFileSync(temporary, JSON.stringify({ chats: Object.fromEntries(this.chats) }), {
      mode: 0o600,
    });
    NodeFS.renameSync(temporary, this.statePath);
  }
}

function asMessage(value: unknown): GraphChatMessage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? (value as GraphChatMessage) : null;
}

/** Chats pinned by conversation id in enabled workspaces; title rules cannot be subscribed. */
export function pinnedGroupChatIds(config: TeamsGatewayConfig): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const [id, workspace] of Object.entries(config.workspaces)) {
    if (!workspace.enabled) continue;
    for (const rule of groupChatWorkspaceTarget(id, workspace).rules) {
      const chatId = rule.conversationId?.split(";messageid=")[0]?.trim();
      if (chatId !== undefined && chatId.startsWith("19:")) ids.add(chatId);
    }
  }
  return [...ids];
}
