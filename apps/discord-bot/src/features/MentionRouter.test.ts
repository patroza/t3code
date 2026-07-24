import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createHandledDiscordMessageTracker,
  findDiscordLinkForT3Target,
  getContinuedConversationModelChangeError,
  isIncompleteDiscordLink,
} from "./MentionRouter.ts";

describe("createHandledDiscordMessageTracker", () => {
  it("marks handled messages and evicts the oldest ids beyond the limit", () => {
    const tracker = createHandledDiscordMessageTracker(2);

    tracker.mark("message-1");
    tracker.mark("message-2");

    expect(tracker.has("message-1")).toBe(true);
    expect(tracker.has("message-2")).toBe(true);

    tracker.mark("message-3");

    expect(tracker.has("message-1")).toBe(false);
    expect(tracker.has("message-2")).toBe(true);
    expect(tracker.has("message-3")).toBe(true);
  });
});

describe("isIncompleteDiscordLink", () => {
  it("is incomplete when the thread-info pin was never stored", () => {
    expect(isIncompleteDiscordLink({})).toBe(true);
    expect(isIncompleteDiscordLink({ infoDiscordMessageId: undefined })).toBe(true);
    expect(isIncompleteDiscordLink({ infoDiscordMessageId: "" })).toBe(true);
  });

  it("is complete when a pin message id exists", () => {
    expect(isIncompleteDiscordLink({ infoDiscordMessageId: "msg-1" })).toBe(false);
  });
});

it("reuses a Discord link for the same canonical worktree", () => {
  const linkedThreadId = ThreadId.make("linked-thread");
  const targetThreadId = ThreadId.make("github-thread");
  const link = {
    discordThreadId: "discord-thread",
    t3ThreadId: linkedThreadId,
    projectId: ProjectId.make("project"),
    channelId: "channel",
    guildId: "guild",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    lastActivityAt: "2026-07-19T00:00:00.000Z",
    status: "active" as const,
    lastSeenTurnId: null,
    lastFinalizedAssistantId: null,
    lastThreadSnapshotSequence: null,
    lastDeliveredSequence: null,
  };
  expect(
    findDiscordLinkForT3Target({
      links: [link],
      threads: [
        { id: linkedThreadId, worktreePath: "/Worktrees/PR-42/" },
        { id: targetThreadId, worktreePath: "/worktrees/pr-42" },
      ],
      target: { id: targetThreadId, worktreePath: "/worktrees/pr-42" },
    }),
  ).toBe(link);
});

describe("getContinuedConversationModelChangeError", () => {
  const providers = [
    {
      driver: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claudeAgent"),
    },
    {
      driver: ProviderDriverKind.make("grok"),
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows switching models mid-conversation within the same provider", () => {
    expect(
      getContinuedConversationModelChangeError({
        providers,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
        },
      }),
    ).toBeNull();
  });

  it("rejects switching providers mid-conversation", () => {
    expect(
      getContinuedConversationModelChangeError({
        providers,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      }),
    ).toContain("within the same provider");
  });

  it("rejects Grok model switches mid-conversation", () => {
    expect(
      getContinuedConversationModelChangeError({
        providers,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toContain("does not allow switching models");
  });
});
