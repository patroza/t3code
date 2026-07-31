import { IdentityUsername, PersonId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { participantDisplayLabel } from "./ParticipantStack.logic";

describe("participantDisplayLabel", () => {
  it("shows all devices for one person in first-seen order", () => {
    expect(
      participantDisplayLabel({
        personId: PersonId.make("patroza"),
        username: IdentityUsername.make("patroza"),
        firstChannel: "desktop",
        channels: ["desktop", "discord"],
        firstParticipatedAt: "2026-07-30T12:00:00.000Z",
      }),
    ).toBe("patroza@desktop,discord");
  });

  it("supports summaries persisted before channel lists were added", () => {
    expect(
      participantDisplayLabel({
        personId: PersonId.make("patroza"),
        username: IdentityUsername.make("patroza"),
        firstChannel: "discord",
        firstParticipatedAt: "2026-07-30T12:00:00.000Z",
      }),
    ).toBe("patroza@discord");
  });
});
