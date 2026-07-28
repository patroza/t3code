// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadTeamsChannelConfigsFromFileSync } from "./config.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

describe("loadTeamsChannelConfigsFromFileSync", () => {
  it("loads root channels arrays", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "teams-config-"));
    tempDirs.push(dir);
    const filePath = NodePath.join(dir, "teams.json");
    await NodeFSP.writeFile(
      filePath,
      JSON.stringify([
        {
          teamId: "team-1",
          channelId: "channel-1",
          channelName: "Prod",
          projectShortName: "MACS-SCANNER",
          discordChannelId: "123",
          company: "Acme",
          environment: "prod",
          companyKeywords: ["acme"],
          environmentKeywords: ["prod"],
          automaticAssessmentEnabled: false,
          internalUserIds: [" user-1 ", "user-2"],
          reactionTriggerTypes: [" Eyes ", "🚨"],
          messageTagTriggers: [" #Investigate ", "#triage"],
        },
      ]),
      "utf8",
    );

    const configs = loadTeamsChannelConfigsFromFileSync(filePath);
    expect(configs).toHaveLength(1);
    expect(configs[0]?.projectShortName).toBe("macs-scanner");
    expect(configs[0]?.automaticAssessmentEnabled).toBe(false);
    expect(configs[0]?.internalUserIds).toEqual(["user-1", "user-2"]);
    expect(configs[0]?.reactionTriggerTypes).toEqual(["eyes", "🚨"]);
    expect(configs[0]?.messageTagTriggers).toEqual(["#investigate", "#triage"]);
  });
});
