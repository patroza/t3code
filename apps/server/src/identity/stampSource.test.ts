import {
  AuthSessionId,
  CommandId,
  IdentityUsername,
  MessageId,
  PersonId,
  ThreadId,
  type SessionIdentityClaim,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sourceRefFromOperateClaim, stampOrchestrationCommandSource } from "./stampSource.ts";

const claim: SessionIdentityClaim = {
  sessionId: AuthSessionId.make("00000000-0000-4000-8000-0000000000aa"),
  personId: PersonId.make("patroza"),
  username: IdentityUsername.make("patroza"),
  claimedAt: "2026-01-01T00:00:00.000Z",
  method: "typeahead",
};

describe("sourceRefFromOperateClaim", () => {
  it("maps desktop deviceType to channel", () => {
    expect(sourceRefFromOperateClaim({ claim, clientDeviceType: "desktop" })).toEqual({
      channel: "desktop",
      personId: "patroza",
      username: "patroza",
    });
  });

  it("maps mobile/tablet to mobile channel", () => {
    expect(sourceRefFromOperateClaim({ claim, clientDeviceType: "mobile" }).channel).toBe("mobile");
    expect(sourceRefFromOperateClaim({ claim, clientDeviceType: "tablet" }).channel).toBe("mobile");
  });
});

describe("stampOrchestrationCommandSource", () => {
  it("stamps only turn.start when claim is present", () => {
    const stamped = stampOrchestrationCommandSource({
      claim,
      clientDeviceType: "desktop",
      command: {
        type: "thread.turn.start",
        commandId: CommandId.make("00000000-0000-4000-8000-0000000000bb"),
        threadId: ThreadId.make("00000000-0000-4000-8000-0000000000cc"),
        message: {
          messageId: MessageId.make("00000000-0000-4000-8000-0000000000dd"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(stamped.type).toBe("thread.turn.start");
    if (stamped.type === "thread.turn.start") {
      expect(stamped.source).toEqual({
        channel: "desktop",
        personId: "patroza",
        username: "patroza",
      });
    }
  });

  it("leaves commands alone without a claim", () => {
    const command = {
      type: "thread.archive" as const,
      commandId: CommandId.make("00000000-0000-4000-8000-0000000000ee"),
      threadId: ThreadId.make("00000000-0000-4000-8000-0000000000ff"),
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(stampOrchestrationCommandSource({ claim: null, command })).toEqual(command);
  });
});
