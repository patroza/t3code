// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalPromise:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  GraphChatSubscriptions,
  type GraphClient,
  type GraphResponse,
} from "./graphChatSubscriptions.ts";

const chatA = "19:a@thread.v2";
const chatB = "19:b@thread.v2";
const url = "https://gateway.example.com/api/graph/notifications";

class FakeGraph implements GraphClient {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  readonly responses: Array<(path: string, body: unknown) => GraphResponse | undefined> = [];
  private next = 1;
  async request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) {
    this.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    for (const respond of this.responses) {
      const response = respond(method + " " + path, body);
      if (response !== undefined) return response;
    }
    if (method === "POST") return { status: 201, body: { id: "sub-" + this.next++ } };
    if (method === "PATCH" || method === "DELETE") return { status: 204, body: null };
    return { status: 404, body: null };
  }
}

describe("Graph chat subscriptions", () => {
  let directory: string;
  let now: number;
  let graph: FakeGraph;
  const make = (chatIds: ReadonlyArray<string>) =>
    new GraphChatSubscriptions({
      graph,
      stateDir: directory,
      notificationUrl: url,
      chatIds,
      now: () => now,
      log: () => {},
    });
  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "graph-subscriptions-"));
    now = Date.parse("2026-11-27T12:00:00.000Z");
    graph = new FakeGraph();
  });
  afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

  it("creates one subscription per pinned chat with a private clientState", async () => {
    const manager = make([chatA, chatB]);
    expect(await manager.reconcile()).toEqual([chatA, chatB]);
    expect(graph.calls[0]).toEqual({
      method: "POST",
      path: "/subscriptions",
      body: {
        changeType: "created",
        resource: `/chats/${chatA}/messages`,
        notificationUrl: url,
        lifecycleNotificationUrl: url,
        expirationDateTime: "2026-11-27T12:55:00.000Z",
        clientState: manager.clientState,
      },
    });
    expect(manager.clientState.length).toBeGreaterThanOrEqual(32);
    const secret = NodePath.join(directory, "graph-notifications-client-state");
    expect(NodeFS.statSync(secret).mode & 0o777).toBe(0o600);
    expect(NodeFS.statSync(NodePath.join(directory, "graph-subscriptions.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(manager.chatForSubscription("sub-2")).toBe(chatB);
    // Nothing is due yet.
    graph.calls.length = 0;
    expect(await manager.reconcile()).toEqual([]);
    expect(graph.calls).toEqual([]);
  });

  it("renews before expiry and reuses persisted subscriptions after a restart", async () => {
    await make([chatA]).reconcile();
    now += 41 * 60_000;
    const restarted = make([chatA]);
    expect(restarted.clientState).toBe(
      NodeFS.readFileSync(NodePath.join(directory, "graph-notifications-client-state"), "utf8"),
    );
    graph.calls.length = 0;
    expect(await restarted.reconcile()).toEqual([]);
    expect(graph.calls).toEqual([
      {
        method: "PATCH",
        path: "/subscriptions/sub-1",
        body: { expirationDateTime: new Date(now + 55 * 60_000).toISOString() },
      },
    ]);
  });

  it("recreates a subscription Graph no longer knows", async () => {
    const manager = make([chatA]);
    await manager.reconcile();
    graph.responses.push((call) =>
      call === "PATCH /subscriptions/sub-1" ? { status: 404, body: null } : undefined,
    );
    now += 45 * 60_000;
    expect(await manager.reconcile()).toEqual([chatA]);
    expect(manager.chatForSubscription("sub-2")).toBe(chatA);
    expect(manager.chatForSubscription("sub-1")).toBeUndefined();
  });

  it("deletes subscriptions of chats that are no longer pinned", async () => {
    await make([chatA, chatB]).reconcile();
    const manager = make([chatB]);
    graph.calls.length = 0;
    await manager.reconcile();
    expect(graph.calls).toEqual([{ method: "DELETE", path: "/subscriptions/sub-1" }]);
    expect(manager.chatForSubscription("sub-1")).toBeUndefined();
    graph.calls.length = 0;
    await make([chatB]).reconcile();
    expect(graph.calls).toEqual([]);
  });

  it("backs off after a failure instead of throwing", async () => {
    graph.responses.push((call) =>
      call === "POST /subscriptions" ? { status: 0, body: null } : undefined,
    );
    const manager = make([chatA]);
    expect(await manager.reconcile()).toEqual([]);
    graph.calls.length = 0;
    now += 30_000;
    await manager.reconcile();
    expect(graph.calls).toEqual([]);
    now += 31_000;
    await manager.reconcile();
    expect(graph.calls).toHaveLength(1);
    now += 61_000;
    await manager.reconcile();
    expect(graph.calls).toHaveLength(1);
    graph.responses.length = 0;
    now += 60_000;
    expect(await manager.reconcile()).toEqual([chatA]);
  });

  it("catches up oldest first from the last seen message and persists it", async () => {
    const list = (path: string) =>
      path.startsWith(`GET /chats/${encodeURIComponent(chatA)}/messages?`)
        ? {
            status: 200,
            body: {
              value: [
                { id: "3", createdDateTime: "2026-11-27T11:30:00.000Z" },
                { id: "2", createdDateTime: "2026-11-27T11:00:00.000Z" },
                { id: "1", createdDateTime: "2026-11-27T10:00:00.000Z" },
              ],
            },
          }
        : undefined;
    graph.responses.push(list);
    const manager = make([chatA]);
    manager.recordSeen(chatA, "2026-11-27T10:00:00.000Z");
    expect((await manager.missedMessages(chatA))?.map((message) => message.id)).toEqual(["2", "3"]);
    manager.recordSeen(chatA, "2026-11-27T11:30:00.000Z");
    manager.recordSeen(chatA, "2026-11-27T11:00:00.000Z");
    expect(make([chatA]).lastSeen(chatA)).toBe("2026-11-27T11:30:00.000Z");
    expect(await make([chatA]).missedMessages(chatA)).toEqual([]);
    expect(graph.calls.at(-1)?.path).toBe(
      `/chats/${encodeURIComponent(chatA)}/messages?$top=50&$orderby=createdDateTime%20desc`,
    );
  });

  it("starts a first catch-up at this week's Monday, bounded by the claim window", async () => {
    graph.responses.push(() => ({
      status: 200,
      body: {
        value: [
          { id: "4", createdDateTime: "2026-11-24T09:00:00.000Z" },
          { id: "5", createdDateTime: "2026-11-22T23:59:00.000Z" },
        ],
      },
    }));
    now = Date.parse("2026-11-24T12:00:00.000Z");
    expect((await make([chatA]).missedMessages(chatA))?.map((message) => message.id)).toEqual([
      "4",
    ]);
    now = Date.parse("2026-11-26T12:00:00.000Z");
    expect(await make([chatA]).missedMessages(chatA)).toEqual([]);
  });
});
