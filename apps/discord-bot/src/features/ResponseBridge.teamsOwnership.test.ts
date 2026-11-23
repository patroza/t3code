import { describe, expect, it } from "vite-plus/test";

import { teamsBridgeOwnsTurn, userMessagesForTurn } from "./ResponseBridge.ts";

const teams = (id: string, turnId: string | null, request: string) => ({
  id,
  role: "user",
  turnId,
  text: `Context\n\nAuthorized Teams request:\n${request}`,
});
const web = (id: string, turnId: string | null, text: string) => ({
  id,
  role: "user",
  turnId,
  text,
});
const answer = (id: string, turnId: string | null) => ({
  id,
  role: "assistant",
  turnId,
  text: `answer ${id}`,
});

// Chain A sent u1 (turn t1), chain B sent u2 (turn t2), web UI sent u3 (turn t3).
const messages = [
  teams("u1", "t1", "first"),
  answer("a1", "t1"),
  teams("u2", "t2", "second"),
  answer("a2", "t2"),
  web("u3", "t3", "from the browser"),
  answer("a3", "t3"),
];

describe("userMessagesForTurn", () => {
  it("prefers user messages tagged with the turn id", () => {
    expect(userMessagesForTurn(messages, "t2").map((message) => message.id)).toEqual(["u2"]);
  });

  it("falls back to the latest user message before the turn's first answer", () => {
    const untagged = [teams("u1", null, "first"), answer("a1", "t1"), teams("u2", null, "x")];
    expect(userMessagesForTurn(untagged, "t1").map((message) => message.id)).toEqual(["u1"]);
    // No answer yet: the latest user message starts the turn.
    expect(userMessagesForTurn(untagged, "t9").map((message) => message.id)).toEqual(["u2"]);
  });
});

describe("teamsBridgeOwnsTurn", () => {
  const ownsFor = (owned: ReadonlyArray<string>, turnId: string | null, list = messages) =>
    teamsBridgeOwnsTurn({ platform: "teams", turnId, messages: list, ownedUserMessageIds: owned });

  it("owns a turn this chain sent", () => {
    expect(ownsFor(["u1"], "t1")).toBe(true);
    expect(ownsFor(["u2"], "t2")).toBe(true);
  });

  it("does not own another chain's turn", () => {
    expect(ownsFor(["u1"], "t2")).toBe(false);
    expect(ownsFor(["u2"], "t1")).toBe(false);
  });

  it("gives a web UI turn to the chain that most recently sent a Teams message", () => {
    expect(ownsFor(["u2"], "t3")).toBe(true);
    expect(ownsFor(["u1"], "t3")).toBe(false);
  });

  it("lets every chain render a web UI turn with no earlier Teams message", () => {
    const list = [web("w1", "t1", "hi"), answer("a1", "t1")];
    expect(ownsFor(["other"], "t1", list)).toBe(true);
  });

  it("does not let a newly joined chain claim an earlier completed turn", () => {
    // Chain B joins with only its first turn's message id; turn t1 belongs to chain A.
    const list = [teams("u1", "t1", "first"), answer("a1", "t1"), teams("u2", "t2", "second")];
    expect(ownsFor(["u2"], "t1", list)).toBe(false);
    expect(ownsFor(["u2"], "t2", list)).toBe(true);
  });

  it("renders every turn for a legacy bridge without remembered ids", () => {
    expect(ownsFor([], "t1")).toBe(true);
    expect(ownsFor([], "t2")).toBe(true);
  });

  it("always owns turns on Discord", () => {
    expect(
      teamsBridgeOwnsTurn({
        platform: "discord",
        turnId: "t2",
        messages,
        ownedUserMessageIds: ["u1"],
      }),
    ).toBe(true);
  });
});
