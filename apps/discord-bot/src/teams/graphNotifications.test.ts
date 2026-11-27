// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalPromise:off globalTimers:off
import { describe, expect, it, vi } from "vite-plus/test";
import { LoopbackTeamsAdapter } from "./gatewayHttp.ts";
import {
  KeyedSerialQueue,
  clientStateMatches,
  graphChatMessageToActivity,
  graphNotificationRoute,
  parseChatMessageResource,
  parseGraphNotifications,
  type GraphChatMessage,
  type GraphNotificationBatch,
} from "./graphNotifications.ts";

const appId = "11111111-1111-4111-8111-111111111111";
const chatId = "19:abc_def@thread.v2";
const user = "33333333-3333-4333-8333-333333333333";

async function withRoute(
  onNotifications: (batch: GraphNotificationBatch) => Promise<void>,
  run: (origin: string) => Promise<void>,
) {
  const adapter = new LoopbackTeamsAdapter(
    new Map([
      [
        "/api/graph/notifications",
        graphNotificationRoute({ clientState: "secret", onNotifications }),
      ],
    ]),
  );
  adapter.registerRoute("POST", "/api/messages", async () => ({ status: 401 }));
  await adapter.start(0);
  try {
    await run("http://127.0.0.1:" + adapter.port);
  } finally {
    await adapter.stop();
  }
}

function message(overrides: Partial<GraphChatMessage> = {}): GraphChatMessage {
  return {
    id: "1795594328476",
    messageType: "message",
    createdDateTime: "2026-11-27T10:00:00.000Z",
    deletedDateTime: null,
    from: { user: { id: user, displayName: "Ada" }, application: null },
    body: { contentType: "html", content: "<p>Scanner &amp; printer<br>are down</p>" },
    attachments: [],
    mentions: [],
    ...overrides,
  };
}

const mapInput = {
  chatId,
  tenantId: "tenant",
  botAppId: appId,
  serviceUrl: "https://smba.trafficmanager.net/teams",
};

describe("Graph change notification endpoint", () => {
  it("echoes the validation token as plain text", async () => {
    const received = vi.fn(async () => {});
    await withRoute(received, async (origin) => {
      const response = await fetch(
        origin + "/api/graph/notifications?validationToken=" + encodeURIComponent("a b+c<d>"),
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/plain/u);
      expect(await response.text()).toBe("a b+c<d>");
    });
    expect(received).not.toHaveBeenCalled();
  });

  it("acknowledges with 202 and drops items whose clientState does not match", async () => {
    const batches: GraphNotificationBatch[] = [];
    let delivered!: () => void;
    const done = new Promise<void>((resolve) => (delivered = resolve));
    await withRoute(
      async (batch) => {
        batches.push(batch);
        delivered();
      },
      async (origin) => {
        const post = (value: unknown[]) =>
          fetch(origin + "/api/graph/notifications", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value }),
          });
        const forged = await post([
          {
            subscriptionId: "s1",
            clientState: "wrong",
            changeType: "created",
            resource: `chats('${chatId}')/messages('1')`,
          },
        ]);
        expect(forged.status).toBe(202);
        const genuine = await post([
          {
            subscriptionId: "s1",
            clientState: "secret",
            changeType: "created",
            resource: `chats('${chatId}')/messages('2')`,
          },
        ]);
        expect(genuine.status).toBe(202);
        await done;
        expect((await fetch(origin + "/api/graph/notifications")).status).toBe(405);
        expect(
          (
            await fetch(origin + "/api/graph/notifications", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "x".repeat(262145),
            })
          ).status,
        ).toBe(413);
        // The SDK callback keeps its own authentication.
        expect(
          (
            await fetch(origin + "/api/messages", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            })
          ).status,
        ).toBe(401);
      },
    );
    expect(batches).toEqual([
      { changes: [{ subscriptionId: "s1", chatId, messageId: "2" }], lifecycle: [] },
    ]);
  });

  it("refuses to shadow the SDK callback", () => {
    expect(() => new LoopbackTeamsAdapter(new Map([["/api/messages", async () => {}]]))).toThrow();
  });
});

describe("Graph notification parsing", () => {
  it("parses chat message resources", () => {
    expect(parseChatMessageResource(`chats('${chatId}')/messages('1795594328476')`)).toEqual({
      chatId,
      messageId: "1795594328476",
    });
    expect(parseChatMessageResource(`/chats/${encodeURIComponent(chatId)}/messages/17`)).toEqual({
      chatId,
      messageId: "17",
    });
    expect(parseChatMessageResource("teams('x')/channels('y')/messages('1')")).toBeNull();
    expect(parseChatMessageResource(`chats('${chatId}')/messages('abc')`)).toBeNull();
    expect(parseChatMessageResource(42)).toBeNull();
  });

  it("separates lifecycle events and compares clientState exactly", () => {
    expect(clientStateMatches("secret", "secret")).toBe(true);
    expect(clientStateMatches("secret", "secreT")).toBe(false);
    expect(clientStateMatches("secret", undefined)).toBe(false);
    expect(
      parseGraphNotifications(
        {
          value: [
            { subscriptionId: "s1", clientState: "secret", lifecycleEvent: "missed" },
            { subscriptionId: "s2", clientState: "secret", lifecycleEvent: "unknown" },
            { subscriptionId: "s3", clientState: "secret", changeType: "updated", resource: "x" },
          ],
        },
        "secret",
      ),
    ).toEqual({ changes: [], lifecycle: [{ subscriptionId: "s1", event: "missed" }] });
    expect(parseGraphNotifications("nope", "secret")).toEqual({ changes: [], lifecycle: [] });
  });
});

describe("Graph chat message to group-chat activity", () => {
  it("maps text, author and conversation like a bot activity", () => {
    const mapped = graphChatMessageToActivity(message(), mapInput);
    expect(mapped.kind).toBe("activity");
    if (mapped.kind !== "activity") return;
    expect(mapped.activity).toMatchObject({
      id: "1795594328476",
      type: "message",
      timestamp: "2026-11-27T10:00:00.000Z",
      text: "Scanner & printer\nare down",
      from: { aadObjectId: user, name: "Ada" },
      recipient: { id: "28:" + appId },
      conversation: {
        id: chatId,
        tenantId: "tenant",
        conversationType: "groupChat",
        isGroup: true,
      },
      entities: [],
    });
  });

  it("detects and strips a bot mention, keeping other mentions", () => {
    const mapped = graphChatMessageToActivity(
      message({
        body: {
          contentType: "html",
          content: '<p><at id="0">Omegent</at> ask <at id="1">Bob</at> please</p>',
        },
        mentions: [
          { id: 0, mentioned: { application: { id: appId.toUpperCase() } } },
          { id: 1, mentioned: { user: { id: "bob" } } },
        ],
      }),
      mapInput,
    );
    expect(mapped.kind === "activity" && mapped.activity.text).toBe("ask Bob please");
    expect(mapped.kind === "activity" && mapped.activity.entities).toEqual([
      { type: "mention", mentioned: { id: "28:" + appId } },
    ]);
  });

  it("skips system, deleted and application messages", () => {
    expect(
      graphChatMessageToActivity(message({ messageType: "systemEventMessage" }), mapInput),
    ).toEqual({ kind: "skip", reason: "not-a-message" });
    expect(
      graphChatMessageToActivity(message({ deletedDateTime: "2026-11-27T10:01:00Z" }), mapInput),
    ).toEqual({ kind: "skip", reason: "deleted" });
    expect(
      graphChatMessageToActivity(
        message({ from: { user: null, application: { id: appId } } }),
        mapInput,
      ),
    ).toEqual({ kind: "skip", reason: "from-application" });
    expect(
      graphChatMessageToActivity(
        message({ from: { user: null, application: { id: "other-bot" } } }),
        mapInput,
      ),
    ).toEqual({ kind: "skip", reason: "from-application" });
  });

  it("lists files and carries quoted replies to the reference loader", () => {
    const mapped = graphChatMessageToActivity(
      message({
        attachments: [
          { id: "f", contentType: "reference", name: "report.pdf", contentUrl: "https://x/y" },
          { id: "1795", contentType: "messageReference", content: '{"messageId":"1795"}' },
        ],
      }),
      mapInput,
    );
    expect(mapped.kind === "activity" && mapped.activity.attachments).toEqual([
      { contentType: "application/vnd.microsoft.teams.file.download.info", name: "report.pdf" },
      {
        contentType: "text/html",
        content: '<blockquote itemtype="http://schema.skype.com/Reply" itemid="1795"></blockquote>',
      },
    ]);
  });
});

describe("KeyedSerialQueue", () => {
  it("runs one key in order and survives a failed task", async () => {
    const queue = new KeyedSerialQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = queue.run("chat", async () => {
      await gate;
      order.push("first");
      throw new Error("boom");
    });
    const second = queue.run("chat", async () => {
      order.push("second");
    });
    const other = queue.run("other", async () => {
      order.push("other");
    });
    await other;
    release();
    await expect(first).rejects.toThrow("boom");
    await second;
    expect(order).toEqual(["other", "first", "second"]);
  });
});
