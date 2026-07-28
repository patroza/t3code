import { describe, expect, it } from "vite-plus/test";

import {
  hasAllowlistedReaction,
  hasInternalTagTrigger,
  looksLikeGermanProblemReport,
  teamsMessageText,
} from "./presentation.ts";

describe("teamsMessageText", () => {
  it("strips html", () => {
    expect(
      teamsMessageText({
        id: "1",
        body: { content: "<div>Hallo <b>Welt</b>&nbsp;&amp; mehr</div>" },
      }),
    ).toBe("Hallo Welt & mehr");
  });
});

describe("looksLikeGermanProblemReport", () => {
  it("matches german production incidents", () => {
    expect(
      looksLikeGermanProblemReport({
        message: {
          id: "1",
          body: { content: "Beim Kunden Acme gibt es seit heute einen Fehler in Produktion." },
        },
        companyKeywords: ["Acme"],
        environmentKeywords: ["Produktion"],
      }),
    ).toBe(true);
  });
});

describe("hasAllowlistedReaction", () => {
  it("matches configured reactions from allowlisted users", () => {
    expect(
      hasAllowlistedReaction({
        message: {
          id: "1",
          reactions: [
            {
              reactionType: "eyes",
              user: {
                user: {
                  id: "internal-user",
                },
              },
            },
          ],
        },
        allowlistedUserIds: ["internal-user"],
        reactionTriggerTypes: ["eyes"],
      }),
    ).toBe(true);
  });
});

describe("hasInternalTagTrigger", () => {
  it("matches tag commands from allowlisted users", () => {
    expect(
      hasInternalTagTrigger({
        message: {
          id: "1",
          from: {
            user: {
              id: "internal-user",
            },
          },
          body: {
            content: "Please take this one #investigate",
          },
        },
        allowlistedUserIds: ["internal-user"],
        messageTagTriggers: ["#investigate"],
      }),
    ).toBe(true);
  });
});
