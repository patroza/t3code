import { Discord } from "dfx";
import { describe, expect, it } from "vite-plus/test";

import {
  formatAskSlashAck,
  isThreadTalkSlashAction,
  OMEGENT_SLASH_COMMAND,
  OMEGENT_SLASH_COMMAND_ALIAS,
  OMEGENT_SLASH_COMMAND_NAME,
  slashDefer,
  slashReply,
  threadTalkSlashReply,
} from "./slashCommands.ts";

describe("Omegent slash command definition", () => {
  it("registers /omegent (alias /agent) with the control-plane subcommands", () => {
    expect(OMEGENT_SLASH_COMMAND_NAME).toBe("omegent");
    expect(OMEGENT_SLASH_COMMAND_ALIAS).toBe("agent");
    expect(OMEGENT_SLASH_COMMAND.name).toBe("omegent");
    const names = OMEGENT_SLASH_COMMAND.options.map((option) => option.name);
    expect(names).toEqual([
      "ask",
      "steer",
      "queue",
      "steernow",
      "help",
      "stop",
      "thread-talk",
      "link",
      "refresh-indicators",
    ]);
  });

  it("uses Discord subcommand option types", () => {
    for (const option of OMEGENT_SLASH_COMMAND.options) {
      expect(option.type).toBe(Discord.ApplicationCommandOptionType.SUB_COMMAND);
    }
    const threadTalk = OMEGENT_SLASH_COMMAND.options.find(
      (option) => option.name === "thread-talk",
    );
    expect(threadTalk?.options?.[0]?.name).toBe("action");
    expect(threadTalk?.options?.[0]?.choices?.map((choice) => choice.value)).toEqual([
      "on",
      "off",
      "status",
    ]);
  });
});

describe("slash reply helpers", () => {
  it("builds public and ephemeral replies", () => {
    const publicReply = slashReply("hello");
    expect(publicReply).toEqual({
      type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "hello" },
    });

    const ephemeralReply = slashReply("secret", { ephemeral: true });
    expect(ephemeralReply).toEqual({
      type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "secret", flags: Discord.MessageFlags.Ephemeral },
    });
  });

  it("builds an ephemeral deferred ack for slow commands", () => {
    expect(slashDefer({ ephemeral: true })).toEqual({
      type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: Discord.MessageFlags.Ephemeral },
    });
  });

  it("formats a public ask ack with optional flags and truncation", () => {
    expect(
      formatAskSlashAck({
        displayName: "Example User",
        prompt: "fix the flaky test",
        plan: true,
        local: false,
      }),
    ).toBe("**Example User** asked (`--plan`):\nfix the flaky test");

    const long = "x".repeat(300);
    const ack = formatAskSlashAck({
      displayName: "Example User",
      prompt: long,
      plan: false,
      local: true,
    });
    expect(ack).toContain("(`--local`)");
    expect(ack.endsWith("…")).toBe(true);
    expect(ack.length).toBeLessThan(long.length + 40);
  });

  it("makes thread-talk status ephemeral and on/off public", () => {
    expect(isThreadTalkSlashAction("on")).toBe(true);
    expect(isThreadTalkSlashAction("nope")).toBe(false);

    const onReply = threadTalkSlashReply({ action: "on", enabled: true });
    expect(onReply).toMatchObject({
      type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: expect.stringContaining("Thread-talk is **on**") },
    });
    expect(onReply).not.toMatchObject({ data: { flags: Discord.MessageFlags.Ephemeral } });

    const statusReply = threadTalkSlashReply({ action: "status", enabled: false });
    expect(statusReply).toMatchObject({
      type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: expect.stringContaining("Thread-talk is **off**"),
        flags: Discord.MessageFlags.Ephemeral,
      },
    });
  });
});
