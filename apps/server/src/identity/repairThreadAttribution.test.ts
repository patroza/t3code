import { Schema } from "effect";
import {
  AuthSessionId,
  IdentityUsername,
  MessageId,
  OrchestrationV2Command,
  PersonId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  hasMcpSessionProvenance,
  planThreadAttributionRepair,
  type AttributionRepairProjection,
} from "./repairThreadAttribution.ts";

const decodePublicCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const claim = {
  sessionId: AuthSessionId.make("confirmed-session"),
  personId: PersonId.make("andrea"),
  username: IdentityUsername.make("andrea"),
  claimedAt: "2026-11-13T00:00:00.000Z",
  method: "settings" as const,
};
function thread(id: string, root = id): AttributionRepairProjection {
  return {
    thread: {
      id: ThreadId.make(id),
      creationSource: "mcp",
      lineage: {
        rootThreadId: ThreadId.make(root),
        parentThreadId: root === id ? null : ThreadId.make(root),
        relationshipToParent: root === id ? null : "subagent",
      },
      originSource: null,
    },
    messages:
      root === id
        ? [{ id: MessageId.make("message:mcp:client%3Aconfirmed-session:request:0"), role: "user" }]
        : [],
  };
}
describe("historical MCP attribution repair", () => {
  it("rejects attribution repair commands from the public dispatch schema", () => {
    expect(() =>
      decodePublicCommand({
        type: "thread.attribution.repair",
        commandId: "repair:external",
        threadId: "root",
        source: { channel: "bot", personId: "andrea", username: "andrea" },
      }),
    ).toThrow();
  });
  it("repairs a verified session's roots and descendants without messages or guessed labels", () => {
    const root = thread("root");
    const child = thread("child", "root");
    const repairs = planThreadAttributionRepair({
      claim,
      projections: new Map([
        [root.thread.id, root],
        [child.thread.id, child],
      ]),
      threadIds: [root.thread.id, child.thread.id, child.thread.id],
    });
    expect(repairs.map((repair) => repair.threadId)).toEqual(["root", "child"]);
    expect(repairs.every((repair) => repair.source.personId === claim.personId)).toBe(true);
  });
  it("rejects unrelated threads and substring matches before returning a plan", () => {
    const unrelated = {
      ...thread("other"),
      messages: [
        {
          id: MessageId.make("message:mcp:client%3Aconfirmed-session-other:request:0"),
          role: "user" as const,
        },
      ],
    };
    expect(hasMcpSessionProvenance(unrelated, claim.sessionId)).toBe(false);
    expect(() =>
      planThreadAttributionRepair({
        claim,
        projections: new Map([[unrelated.thread.id, unrelated]]),
        threadIds: [unrelated.thread.id],
      }),
    ).toThrow("no recorded launch provenance");
  });
  it("is idempotent and never overwrites another person's attribution", () => {
    const base = thread("own");
    const own = {
      ...base,
      thread: {
        ...base.thread,
        originSource: { channel: "unknown" as const, personId: claim.personId },
      },
    };
    expect(
      planThreadAttributionRepair({
        claim,
        projections: new Map([[own.thread.id, own]]),
        threadIds: [own.thread.id],
      }),
    ).toEqual([]);
    const other = {
      ...own,
      thread: {
        ...own.thread,
        originSource: { channel: "unknown" as const, personId: PersonId.make("someone-else") },
      },
    };
    expect(() =>
      planThreadAttributionRepair({
        claim,
        projections: new Map([[other.thread.id, other]]),
        threadIds: [other.thread.id],
      }),
    ).toThrow("already attributed");
  });
});
