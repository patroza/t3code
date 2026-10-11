import { describe, expect, it } from "vite-plus/test";
import { discordMessageFields } from "./ResponseTransport.ts";
import { workingFields, wakeUpFields, idleFields } from "../features/BotResponseTransport.ts";
import {
  workingMessageFields,
  wakeUpMessageFields,
  idleMessageFields,
} from "../presentation/messages.ts";

describe("Discord transport compatibility", () => {
  it("keeps existing Stop and Continue wire payloads compatible with installed handlers", () => {
    expect(discordMessageFields(workingFields("Working…", "thread"))).toEqual(
      workingMessageFields("Working…", "thread"),
    );
    expect(discordMessageFields(wakeUpFields("Continue?", "thread"))).toEqual(
      wakeUpMessageFields("Continue?", "thread"),
    );
    expect(discordMessageFields(idleFields("Done"))).toEqual(idleMessageFields("Done"));
  });
});
