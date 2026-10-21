import { describe, expect, it } from "vite-plus/test";
import { renderThreadInfoPin } from "../presentation/threadInfoPin.ts";
import { discordMessageFields } from "./ResponseTransport.ts";
import {
  workingFields,
  wakeUpFields,
  idleFields,
  messageUpdateError,
} from "../features/BotResponseTransport.ts";
import {
  workingMessageFields,
  wakeUpMessageFields,
  idleMessageFields,
} from "../presentation/messages.ts";

describe("Discord transport compatibility", () => {
  it("preserves the clickable thread-info link in Discord message content", () => {
    const content = renderThreadInfoPin({
      modelLine: "grok/grok-4.7",
      worktreeLine: null,
      webLink: "https://omega.example/?thread=scanner-thread",
    });
    expect(discordMessageFields(idleFields(content)).content).toContain(
      "[Open in Omegent](https://omega.example/?thread=scanner-thread)",
    );
  });
  it("keeps existing Stop and Continue wire payloads compatible with installed handlers", () => {
    expect(discordMessageFields(workingFields("Working…", "thread"))).toEqual(
      workingMessageFields("Working…", "thread"),
    );
    expect(discordMessageFields(wakeUpFields("Continue?", "thread"))).toEqual(
      wakeUpMessageFields("Continue?", "thread"),
    );
    expect(discordMessageFields(idleFields("Done"))).toEqual(idleMessageFields("Done"));
  });

  it("lets a finished transient reply ping @everyone and keeps Working quiet", () => {
    expect(discordMessageFields(idleFields("severity: transient\n\n@everyone"))).toMatchObject({
      allowed_mentions: { parse: ["users", "roles", "everyone"] },
    });
    expect(
      discordMessageFields(workingFields("severity: transient\n\n@everyone", "thread")),
    ).not.toHaveProperty("allowed_mentions");
  });
});

describe("chat transport update failures", () => {
  it.each([404, 429, 500, 401])(
    "classifies HTTP %s without replacing transient/auth failures",
    (status) => {
      expect(messageUpdateError({ response: { status } }).reason).toBe(
        status === 404 ? "message-not-found" : undefined,
      );
    },
  );
});
