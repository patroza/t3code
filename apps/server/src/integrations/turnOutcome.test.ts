import { describe, expect, it } from "@effect/vitest";
import { IntegrationThreadView } from "@t3tools/shared/integrationThreadView";
import * as Schema from "effect/Schema";

import {
  discoverTargetTurnId,
  finalAnswerText,
  finalAnswerWithStats,
  resolveBridgeTurnOutcome,
} from "./turnOutcome.ts";

const decodeIntegrationThreadView = Schema.decodeUnknownSync(IntegrationThreadView);

function message(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId: string | null;
  readonly streaming?: boolean;
}) {
  return {
    id: input.id,
    role: input.role,
    text: input.text,
    turnId: input.turnId,
    streaming: input.streaming ?? false,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

function threadFixture(input: {
  readonly messages: ReadonlyArray<ReturnType<typeof message>>;
  readonly latestTurn?: {
    readonly turnId: string;
    readonly state: "running" | "completed" | "interrupted" | "error";
  } | null;
  readonly session?: {
    readonly status:
      | "running"
      | "ready"
      | "starting"
      | "idle"
      | "interrupted"
      | "stopped"
      | "error";
    readonly activeTurnId: string | null;
  } | null;
  readonly checkpoints?: ReadonlyArray<{ readonly turnId: string }>;
  readonly modelSelection?: {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
  };
  readonly activities?: ReadonlyArray<{
    readonly kind: string;
    readonly turnId: string | null;
    readonly payload: unknown;
  }>;
}) {
  return decodeIntegrationThreadView({
    id: "thread-1",
    projectId: "project-1",
    title: "PR #1",
    pullRequests: [],
    settledOverride: null,
    settledAt: null,
    modelSelection: input.modelSelection ?? {
      instanceId: "codex",
      model: "gpt-5.4",
      options: [],
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: "feature",
    worktreePath: "/tmp/wt",
    latestTurn:
      input.latestTurn === undefined
        ? null
        : input.latestTurn === null
          ? null
          : {
              turnId: input.latestTurn.turnId,
              state: input.latestTurn.state,
              requestedAt: "2026-07-22T00:00:00.000Z",
              startedAt: "2026-07-22T00:00:00.000Z",
              completedAt: input.latestTurn.state === "running" ? null : "2026-07-22T00:01:00.000Z",
              assistantMessageId: null,
            },
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:01:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: input.messages,
    proposedPlans: [],
    activities: (input.activities ?? []).map((activity, index) => ({
      id: `test-activity:${index}`,
      tone: "info",
      summary: "Activity",
      createdAt: "2026-07-22T00:00:00.000Z",
      ...activity,
    })),
    checkpoints: (input.checkpoints ?? []).map((checkpoint) => ({
      turnId: checkpoint.turnId,
      checkpointTurnCount: 1,
      checkpointRef: "test-ref",
      status: "ready" as const,
      files: [],
      assistantMessageId: null,
      completedAt: "2026-07-22T00:01:00.000Z",
    })),
    session:
      input.session === undefined
        ? null
        : input.session === null
          ? null
          : {
              threadId: "thread-1",
              status:
                input.session.status === "idle"
                  ? "ready"
                  : input.session.status === "interrupted"
                    ? "stopped"
                    : input.session.status,
              providerName: "codex",
              providerInstanceId: "codex",
              providerSessionId: null,
              providerThreadId: null,
              activeTurnId: input.session.activeTurnId,
              lastError: null,
              updatedAt: "2026-07-22T00:01:00.000Z",
              runtimeMode: "full-access" as const,
            },
  });
}

describe("integration bridge turn resolution", () => {
  it("discovers the target turn from the dispatched user message", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "u0", role: "user", text: "prior", turnId: null }),
        message({ id: "a0", role: "assistant", text: "prior answer", turnId: "turn-0" }),
        message({ id: "u1", role: "user", text: "From GH: plan", turnId: null }),
        message({ id: "a1", role: "assistant", text: "working", turnId: "turn-1" }),
        message({ id: "a2", role: "assistant", text: "final plan body", turnId: "turn-1" }),
      ],
      latestTurn: { turnId: "turn-1", state: "completed" },
    });

    expect(
      discoverTargetTurnId(thread, {
        userMessageId: "u1",
        previousTurnId: "turn-0",
        knownTargetTurnId: null,
      }),
    ).toBe("turn-1");
    expect(finalAnswerText(thread, "turn-1")).toBe("final plan body");
  });

  it("finalizes a completed target turn even when latestTurn is wiped null", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "u1", role: "user", text: "From GH: plan", turnId: null }),
        message({
          id: "a1",
          role: "assistant",
          text: "Implementation plan added and pushed.",
          turnId: "turn-1",
        }),
      ],
      latestTurn: null,
      session: { status: "ready", activeTurnId: null },
      checkpoints: [{ turnId: "turn-1" }],
    });

    expect(
      resolveBridgeTurnOutcome(thread, {
        userMessageId: "u1",
        previousTurnId: null,
        knownTargetTurnId: "turn-1",
      }),
    ).toEqual({
      _tag: "terminal",
      status: "completed",
      body: "Implementation plan added and pushed.\n\n_`gpt-5.4`_",
      targetTurnId: "turn-1",
    });
  });

  it("does not post a later Discord wake-up answer for an earlier GitHub turn", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "u1", role: "user", text: "From GH: plan", turnId: null }),
        message({
          id: "a1",
          role: "assistant",
          text: "Original GH final answer with the real plan details.",
          turnId: "turn-1",
        }),
        message({ id: "u2", role: "user", text: "repeat", turnId: null }),
        message({
          id: "a2",
          role: "assistant",
          text: "Wake-up re-summary that should not replace the GH answer.",
          turnId: "turn-2",
        }),
      ],
      latestTurn: { turnId: "turn-2", state: "completed" },
      session: { status: "ready", activeTurnId: null },
    });

    const outcome = resolveBridgeTurnOutcome(thread, {
      userMessageId: "u1",
      previousTurnId: null,
      knownTargetTurnId: "turn-1",
    });
    expect(outcome).toEqual({
      _tag: "terminal",
      status: "completed",
      // Stats omit duration when latestTurn is a different turn; model still attaches.
      body: "Original GH final answer with the real plan details.\n\n_`gpt-5.4`_",
      targetTurnId: "turn-1",
    });
    expect(finalAnswerText(thread)).toBe(
      "Wake-up re-summary that should not replace the GH answer.",
    );
  });

  it("appends model, effort, duration, and token stats to completed GitHub answers", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "u1", role: "user", text: "From GH: plan", turnId: null }),
        message({
          id: "a1",
          role: "assistant",
          text: "Ship it.",
          turnId: "turn-1",
        }),
      ],
      latestTurn: { turnId: "turn-1", state: "completed" },
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.4",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      activities: [
        {
          kind: "context-window.updated",
          turnId: "turn-1",
          payload: {
            usedTokens: 5000,
            lastInputTokens: 1200,
            lastOutputTokens: 340,
            durationMs: 45_000,
          },
        },
      ],
    });

    expect(finalAnswerWithStats(thread, "turn-1")).toBe(
      "Ship it.\n\n_`gpt-5.4` · effort high · fast · 45s · ↑1.2k ↓340_",
    );
    expect(
      resolveBridgeTurnOutcome(thread, {
        userMessageId: "u1",
        previousTurnId: null,
        knownTargetTurnId: "turn-1",
      }),
    ).toMatchObject({
      _tag: "terminal",
      status: "completed",
      body: "Ship it.\n\n_`gpt-5.4` · effort high · fast · 45s · ↑1.2k ↓340_",
      targetTurnId: "turn-1",
    });
  });

  it("keeps waiting while the target turn is still running", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "u1", role: "user", text: "From GH: plan", turnId: null }),
        message({
          id: "a1",
          role: "assistant",
          text: "still working",
          turnId: "turn-1",
          streaming: true,
        }),
      ],
      latestTurn: { turnId: "turn-1", state: "running" },
      session: { status: "running", activeTurnId: "turn-1" },
    });

    expect(
      resolveBridgeTurnOutcome(thread, {
        userMessageId: "u1",
        previousTurnId: null,
        knownTargetTurnId: null,
      }),
    ).toEqual({ _tag: "waiting" });
  });

  it("legacy delivery without userMessageId pins the first turn after previous, not a later wake-up", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "a0", role: "assistant", text: "prior", turnId: "turn-0" }),
        message({ id: "u1", role: "user", text: "From GH: implement", turnId: null }),
        message({
          id: "a1",
          role: "assistant",
          text: "Original implement answer that the stuck delivery must post.",
          turnId: "turn-1",
        }),
        message({ id: "u2", role: "user", text: "From GH: repeat the result?", turnId: null }),
        message({
          id: "a2",
          role: "assistant",
          text: "Wake-up restatement that must not be double-posted by the stuck delivery.",
          turnId: "turn-2",
        }),
      ],
      latestTurn: { turnId: "turn-2", state: "completed" },
      session: { status: "ready", activeTurnId: null },
      checkpoints: [{ turnId: "turn-1" }, { turnId: "turn-2" }],
    });

    expect(
      discoverTargetTurnId(thread, {
        userMessageId: null,
        previousTurnId: "turn-0",
        knownTargetTurnId: null,
      }),
    ).toBe("turn-1");

    expect(
      resolveBridgeTurnOutcome(thread, {
        userMessageId: null,
        previousTurnId: "turn-0",
        knownTargetTurnId: null,
      }),
    ).toEqual({
      _tag: "terminal",
      status: "completed",
      // Stats omit duration when latestTurn is a different turn; model still attaches.
      body: "Original implement answer that the stuck delivery must post.\n\n_`gpt-5.4`_",
      targetTurnId: "turn-1",
    });
  });

  it("legacy delivery recovers the original turn when previousTurnId is outside the message window", () => {
    const thread = threadFixture({
      messages: [
        // previous turn-0 dropped from the detail window
        message({
          id: "a1",
          role: "assistant",
          text: "Implement answer retained after truncation.",
          turnId: "turn-1",
        }),
        message({
          id: "a2",
          role: "assistant",
          text: "Later wake-up answer.",
          turnId: "turn-2",
        }),
      ],
      latestTurn: { turnId: "turn-2", state: "completed" },
      session: { status: "ready", activeTurnId: null },
    });

    expect(
      discoverTargetTurnId(thread, {
        userMessageId: null,
        previousTurnId: "turn-0",
        knownTargetTurnId: null,
      }),
    ).toBe("turn-1");
  });

  it("new wake-up delivery with userMessageId still targets only its own turn", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "a0", role: "assistant", text: "prior", turnId: "turn-0" }),
        message({
          id: "a1",
          role: "assistant",
          text: "Original implement answer.",
          turnId: "turn-1",
        }),
        message({ id: "u2", role: "user", text: "From GH: repeat", turnId: null }),
        message({
          id: "a2",
          role: "assistant",
          text: "Wake-up restatement for the new delivery only.",
          turnId: "turn-2",
        }),
      ],
      latestTurn: { turnId: "turn-2", state: "completed" },
      session: { status: "ready", activeTurnId: null },
    });

    expect(
      resolveBridgeTurnOutcome(thread, {
        userMessageId: "u2",
        previousTurnId: "turn-1",
        knownTargetTurnId: null,
      }),
    ).toEqual({
      _tag: "terminal",
      status: "completed",
      body: "Wake-up restatement for the new delivery only.\n\n_`gpt-5.4` · 1m 0s_",
      targetTurnId: "turn-2",
    });
  });
});

describe("native queued run delivery ownership", () => {
  it("waits for the queued delivery even when another run has an answer", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "queued-user", role: "user", text: "Queued request", turnId: "queued-run" }),
        message({
          id: "other-answer",
          role: "assistant",
          text: "Answer for another delivery",
          turnId: "other-run",
        }),
      ],
      latestTurn: { turnId: "other-run", state: "completed" },
    });
    expect(
      resolveBridgeTurnOutcome(
        {
          ...thread,
          runStatuses: [
            { id: "queued-run", status: "queued", userMessageId: thread.messages[0]!.id },
          ],
        },
        { userMessageId: "queued-user", previousTurnId: null, knownTargetTurnId: null },
      ),
    ).toEqual({ _tag: "waiting" });
  });

  it("rejects a failed target without waiting for or posting a later run", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "failed-user", role: "user", text: "Failed request", turnId: "failed-run" }),
        message({
          id: "later-answer",
          role: "assistant",
          text: "Unrelated later answer",
          turnId: "later-run",
        }),
      ],
      latestTurn: { turnId: "later-run", state: "completed" },
    });
    const outcome = resolveBridgeTurnOutcome(
      {
        ...thread,
        runStatuses: [
          { id: "failed-run", status: "failed", userMessageId: thread.messages[0]!.id },
        ],
      },
      { userMessageId: "failed-user", previousTurnId: null, knownTargetTurnId: null },
    );
    expect(outcome).toMatchObject({
      _tag: "terminal",
      status: "rejected",
      targetTurnId: "failed-run",
    });
    if (outcome._tag === "terminal") expect(outcome.body).not.toContain("Unrelated later answer");
  });
});
