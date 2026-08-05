import { describe, expect, it } from "vite-plus/test";

import {
  ownersForPaths,
  pathMatchesOwnershipPattern,
  type ClientOverlayOwnership,
} from "./client-overlay-owner.ts";

const overlays: ReadonlyArray<ClientOverlayOwnership> = [
  {
    id: "discord",
    branch: "fork/discord",
    pullRequest: null,
    paths: ["apps/discord-bot/**", "docs/integrations/discord-bot.md"],
  },
  {
    id: "vscode",
    branch: "fork/vscode",
    pullRequest: 99,
    paths: ["apps/vscode/**"],
  },
];

describe("client overlay ownership", () => {
  it("matches exact files and recursive directory patterns", () => {
    expect(pathMatchesOwnershipPattern("apps/discord-bot/src/main.ts", "apps/discord-bot/**")).toBe(
      true,
    );
    expect(
      pathMatchesOwnershipPattern(
        "docs/integrations/discord-bot.md",
        "docs/integrations/discord-bot.md",
      ),
    ).toBe(true);
    expect(pathMatchesOwnershipPattern("apps/discord/src/main.ts", "apps/discord-bot/**")).toBe(
      false,
    );
  });

  it("finds every overlay touched by a mixed change", () => {
    expect(
      ownersForPaths(overlays, [
        "packages/contracts/src/orchestration.ts",
        "apps/discord-bot/src/main.ts",
        "apps/vscode/src/extension.ts",
      ]).map((owner) => owner.id),
    ).toEqual(["discord", "vscode"]);
  });
});
