// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { applyStoredThreadAttribution } from "./applyThreadAttribution.ts";

const previousPath = process.env.T3_IDENTITY_MAP_PATH;

afterEach(() => {
  if (previousPath === undefined) {
    delete process.env.T3_IDENTITY_MAP_PATH;
  } else {
    process.env.T3_IDENTITY_MAP_PATH = previousPath;
  }
});

describe("applyStoredThreadAttribution", () => {
  it("maps a Discord snowflake on originSource to the identity-map person", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-identity-"));
    const mapPath = NodePath.join(dir, "identity-map.yaml");
    NodeFS.writeFileSync(
      mapPath,
      `people:
  "147977704522645504":
    username: enricopolanski
    name: Enrico Polanski
`,
    );
    process.env.T3_IDENTITY_MAP_PATH = mapPath;

    const enriched = applyStoredThreadAttribution({
      originSource: {
        channel: "discord",
        actor: { platformId: "147977704522645504", displayName: "enricopolanski" },
      },
      participantSummaries: [],
      createdAt: "2026-09-18T00:00:00.000Z",
    });

    expect(enriched.originSource?.personId).toBe("enricopolanski");
    expect(enriched.originSource?.username).toBe("enricopolanski");
    expect(enriched.participantSummaries?.[0]?.personId).toBe("enricopolanski");
  });

  it("recovers origin from the Discord overlay when bootstrap stored no SourceRef", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-identity-"));
    const mapPath = NodePath.join(dir, "identity-map.yaml");
    NodeFS.writeFileSync(
      mapPath,
      `people:
  "147977704522645504":
    username: enricopolanski
    name: Enrico Polanski
`,
    );
    process.env.T3_IDENTITY_MAP_PATH = mapPath;

    const enriched = applyStoredThreadAttribution({
      originSource: null,
      participantSummaries: [],
      createdAt: "2026-09-25T09:18:14.418Z",
      messages: [
        {
          role: "user",
          createdAt: "2026-09-25T09:18:14.418Z",
          text: "req: 147977704522645504@enricopolanski\n## User request\nHi",
        },
      ],
    });

    expect(enriched.originSource?.personId).toBe("enricopolanski");
    expect(enriched.participantSummaries?.[0]?.personId).toBe("enricopolanski");
  });
});
