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

import {
  buildIntegrationSourceRef,
  sourceRefFromOperateClaim,
  stampOrchestrationCommandSource,
} from "./stampSource.ts";

const claim: SessionIdentityClaim = {
  sessionId: AuthSessionId.make("00000000-0000-4000-8000-0000000000aa"),
  personId: PersonId.make("patroza"),
  username: IdentityUsername.make("patroza"),
  claimedAt: "2026-01-01T00:00:00.000Z",
  method: "typeahead",
};

const people = [
  {
    personId: "patroza",
    username: "patroza",
    name: "Patrick",
    discord: { id: "95218063095377920" },
    github: { login: "patroza", id: "42661" },
    jira: { accountId: "jira-pat", email: "p@example.com" },
  },
] as const;

describe("sourceRefFromOperateClaim", () => {
  it("maps desktop deviceType to channel", () => {
    expect(sourceRefFromOperateClaim({ claim, clientDeviceType: "desktop" })).toEqual({
      channel: "desktop",
      personId: "patroza",
      username: "patroza",
    });
  });
});

describe("buildIntegrationSourceRef", () => {
  it("resolves github actor to map person", () => {
    const source = buildIntegrationSourceRef({
      people,
      channel: "github",
      platformId: "42661",
      displayName: "patroza",
      location: { owner: "pingdotgg", repo: "t3code", number: 1, kind: "pr" },
    });
    expect(source.channel).toBe("github");
    expect(source.personId).toBe("patroza");
    expect(source.username).toBe("patroza");
    expect(source.location?.number).toBe(1);
  });

  it("resolves discord snowflake", () => {
    const source = buildIntegrationSourceRef({
      people,
      channel: "discord",
      platformId: "95218063095377920",
      displayName: "patroza",
    });
    expect(source.personId).toBe("patroza");
    expect(source.channel).toBe("discord");
  });

  it("leaves person unset when unmapped", () => {
    const source = buildIntegrationSourceRef({
      people,
      channel: "jira",
      platformId: "unknown-account",
      displayName: "Ghost",
    });
    expect(source.personId).toBeUndefined();
    expect(source.actor?.platformId).toBe("unknown-account");
  });
});

describe("stampOrchestrationCommandSource", () => {
  const baseCommand = {
    type: "thread.turn.start" as const,
    commandId: CommandId.make("00000000-0000-4000-8000-0000000000bb"),
    threadId: ThreadId.make("00000000-0000-4000-8000-0000000000cc"),
    message: {
      messageId: MessageId.make("00000000-0000-4000-8000-0000000000dd"),
      role: "user" as const,
      text: "hello",
      attachments: [],
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("stamps from claim for interactive clients", () => {
    const stamped = stampOrchestrationCommandSource({
      claim,
      clientDeviceType: "desktop",
      command: baseCommand,
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

  it("stamps from discord sourceHint for bot sessions", () => {
    const stamped = stampOrchestrationCommandSource({
      claim: null,
      clientDeviceType: "bot",
      people,
      command: {
        ...baseCommand,
        sourceHint: {
          channel: "discord",
          actor: {
            platformId: "95218063095377920",
            displayName: "patroza",
          },
          location: {
            guildId: "1083767712431480922",
            channelId: "1532311945326235829",
          },
        },
      },
    });
    if (stamped.type === "thread.turn.start") {
      expect(stamped.source?.personId).toBe("patroza");
      expect(stamped.source?.channel).toBe("discord");
      expect(stamped.sourceHint).toBeUndefined();
      expect(stamped.source?.location?.guildId).toBe("1083767712431480922");
    }
  });
});
