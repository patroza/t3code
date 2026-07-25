import { describe, expect, it } from "vite-plus/test";

import {
  bridgedTurnTopicResolutionError,
  missingProjectBindingMessage,
  normalizeWorkspacePath,
  parseMentionFlags,
  parseMentionIntent,
  parseTopicShortName,
  projectTopicFromParentLookup,
  readChannelTopic,
  resolveDiscordFollowUpDelivery,
} from "./mentions.ts";
import {
  chunkDiscordContent,
  formatInProgressChunk,
  inProgressChunkLimit,
  stripBotMention,
  stripWorkingIndicator,
  truncateTitle,
  WORKING_INDICATOR,
} from "./messages.ts";

describe("parseTopicShortName", () => {
  it("extracts short names from channel topics", () => {
    expect(parseTopicShortName("t3-example-project")).toBe("example-project");
    expect(parseTopicShortName("Project channel t3-example-project please")).toBe(
      "example-project",
    );
    expect(parseTopicShortName("T3-Example-Project")).toBe("example-project");
    expect(parseTopicShortName("no alias here")).toBeNull();
  });
});

describe("project topic lookup", () => {
  it("reads topic from channel-like objects", () => {
    expect(readChannelTopic({ topic: "t3-example-project" })).toBe("t3-example-project");
    expect(readChannelTopic({ topic: null })).toBeNull();
    expect(readChannelTopic({ id: "1" })).toBeNull();
    expect(readChannelTopic(null)).toBeNull();
  });

  it("uses parent topic when parent fetch succeeds", () => {
    expect(
      projectTopicFromParentLookup({
        channel: { topic: null },
        parentId: "parent-1",
        parent: { ok: true, channel: { topic: "t3-configurator please" } },
      }),
    ).toEqual({
      kind: "resolved",
      topic: "t3-configurator please",
      parentChannelId: "parent-1",
    });
  });

  it("does not treat a failed parent fetch as a missing t3 tag", () => {
    expect(
      projectTopicFromParentLookup({
        channel: { topic: null },
        parentId: "parent-1",
        parent: { ok: false, cause: "503 Service Unavailable" },
      }),
    ).toEqual({
      kind: "parent-unavailable",
      parentChannelId: "parent-1",
      cause: "503 Service Unavailable",
    });
  });

  it("uses the channel topic when not in a thread", () => {
    expect(
      projectTopicFromParentLookup({
        channel: { topic: "t3-example-project" },
        parentId: null,
        parent: null,
      }),
    ).toEqual({
      kind: "resolved",
      topic: "t3-example-project",
      parentChannelId: null,
    });
  });

  it("writes distinct user-facing errors for outages vs missing tags", () => {
    expect(missingProjectBindingMessage({ inThread: true, parentUnavailable: true })).toContain(
      "Discord API may be degraded",
    );
    expect(missingProjectBindingMessage({ inThread: true, parentUnavailable: false })).toContain(
      "t3-<shortName>",
    );
    expect(
      bridgedTurnTopicResolutionError({
        topicError: "Channel topic has no t3-<shortName> tag.",
        parentUnavailable: true,
        hasExistingLink: false,
        recoveredFromLink: false,
      }),
    ).toContain("Discord API may be degraded");
    expect(
      bridgedTurnTopicResolutionError({
        topicError: "Channel topic has no t3-<shortName> tag.",
        parentUnavailable: true,
        hasExistingLink: true,
        recoveredFromLink: true,
      }),
    ).toBeNull();
  });
});

describe("parseMentionFlags", () => {
  it("parses flags and residual prompt", () => {
    const parsed = parseMentionFlags(
      "--plan --local --base develop --model compose-2.5 --provider grok fix the flaky test",
    );
    expect(parsed).toEqual({
      model: "compose-2.5",
      provider: "grok",
      base: "develop",
      local: true,
      plan: true,
      prompt: "fix the flaky test",
    });
  });

  it("parses --steer and --queue with last-wins when both appear", () => {
    expect(parseMentionFlags("--steer also check the race").followUpDelivery).toBe("steer");
    expect(parseMentionFlags("--queue park this for later").followUpDelivery).toBe("queue");
    expect(parseMentionFlags("--steer --queue prefer queue").followUpDelivery).toBe("queue");
    expect(parseMentionFlags("--queue --steer prefer steer").followUpDelivery).toBe("steer");
    expect(parseMentionFlags("plain follow-up").followUpDelivery).toBeUndefined();
  });
});

describe("resolveDiscordFollowUpDelivery", () => {
  it("defaults mid-turn Discord delivery to queue", () => {
    expect(resolveDiscordFollowUpDelivery({})).toBe("queue");
    expect(resolveDiscordFollowUpDelivery({ followUpDelivery: "steer" })).toBe("steer");
    expect(resolveDiscordFollowUpDelivery({ followUpDelivery: "queue" })).toBe("queue");
  });
});

describe("parseMentionIntent", () => {
  it("recognizes stop words as interrupt commands", () => {
    expect(parseMentionIntent("stop")).toEqual({ kind: "interrupt" });
    expect(parseMentionIntent(" cancel! ")).toEqual({ kind: "interrupt" });
    expect(parseMentionIntent("--plan abort")).toEqual({ kind: "interrupt" });
  });

  it("recognizes help as a help command", () => {
    expect(parseMentionIntent("help")).toEqual({ kind: "help" });
    expect(parseMentionIntent(" help! ")).toEqual({ kind: "help" });
  });

  it("recognizes refresh-indicators as a control command", () => {
    expect(parseMentionIntent("refresh-indicators")).toEqual({ kind: "refresh-indicators" });
    expect(parseMentionIntent("refresh indicators")).toEqual({ kind: "refresh-indicators" });
    expect(parseMentionIntent("refresh title")).toEqual({ kind: "refresh-indicators" });
  });

  it("keeps normal prompts as prompts", () => {
    expect(parseMentionIntent("stop using the flaky snapshot test")).toEqual({
      kind: "prompt",
      local: false,
      plan: false,
      prompt: "stop using the flaky snapshot test",
    });
  });

  it("recognizes link / pick-up of an existing T3 thread", () => {
    expect(parseMentionIntent("link abc-123")).toEqual({
      kind: "link-thread",
      t3ThreadId: "abc-123",
    });
    expect(parseMentionIntent("pick-up https://t3.example/?thread=uuid-1&foo=1")).toEqual({
      kind: "link-thread",
      t3ThreadId: "uuid-1",
    });
    expect(parseMentionIntent("pickup http://localhost:5173/?thread=tid-9")).toEqual({
      kind: "link-thread",
      t3ThreadId: "tid-9",
    });
  });

  it("does not treat ordinary prompts starting with link words as link commands", () => {
    expect(parseMentionIntent("link these files together")).toEqual({
      kind: "prompt",
      local: false,
      plan: false,
      prompt: "link these files together",
    });
    expect(parseMentionIntent("please pick-up the slack")).toEqual({
      kind: "prompt",
      local: false,
      plan: false,
      prompt: "please pick-up the slack",
    });
  });
});

describe("message helpers", () => {
  it("strips bot mentions", () => {
    expect(stripBotMention("<@123> please help <@!123>", "123")).toBe("please help");
  });

  it("strips the app-managed role mention when provided", () => {
    expect(stripBotMention("<@&456> thread-talk on", "123", "456")).toBe("thread-talk on");
  });

  it("chunks long content", () => {
    const chunks = chunkDiscordContent("a".repeat(2500), 2000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBeLessThanOrEqual(2000);
  });

  it("appends italic Working.. only on the last in-progress chunk", () => {
    expect(formatInProgressChunk("partial answer", true)).toContain(WORKING_INDICATOR);
    expect(formatInProgressChunk("partial answer", true).endsWith(WORKING_INDICATOR)).toBe(true);
    expect(WORKING_INDICATOR).toBe("_Working.._");
    expect(formatInProgressChunk("older chunk", false)).toBe("older chunk");
    expect(formatInProgressChunk("", true)).toBe(WORKING_INDICATOR);
    expect(formatInProgressChunk("x".repeat(1990), true).length).toBeLessThanOrEqual(2000);
    expect(inProgressChunkLimit(2000)).toBeLessThan(2000);
  });

  it("strips Working.. from finalized content", () => {
    expect(stripWorkingIndicator(`partial answer\n\n${WORKING_INDICATOR}`)).toBe("partial answer");
    expect(stripWorkingIndicator("partial answer\n\nWorking..")).toBe("partial answer");
    expect(stripWorkingIndicator(WORKING_INDICATOR)).toBe("");
    expect(stripWorkingIndicator("keep Working.. in the middle")).toBe(
      "keep Working.. in the middle",
    );
  });

  it("truncates titles", () => {
    expect(truncateTitle("short")).toBe("short");
    expect(truncateTitle("x".repeat(120)).length).toBe(100);
  });
});

describe("normalizeWorkspacePath", () => {
  it("normalizes separators and trailing slashes", () => {
    expect(normalizeWorkspacePath("/tmp/Foo/")).toBe("/tmp/foo");
  });
});
