import { describe, expect, it } from "vite-plus/test";

import {
  buildMergeMessage,
  buildPrBody,
  classifyConflicts,
  computeOverlap,
  decideBudgetLabel,
  mergeLocaleJson,
  parseLogNameOnly,
} from "./merge-upstream.mjs";

describe("classifyConflicts", () => {
  it("auto-resolves only the lockfile and app locale catalogs", () => {
    expect(
      classifyConflicts([
        "pnpm-lock.yaml",
        "apps/web/src/i18n/translations/de.json",
        "apps/mobile/src/i18n/translations/pt-BR.json",
        "apps/web/src/i18n/config.json",
        "packages/x/pnpm-lock.yaml",
        "apps/server/src/mcp/McpHttpServer.ts",
      ]),
    ).toEqual({
      lockfile: ["pnpm-lock.yaml"],
      locale: [
        "apps/web/src/i18n/translations/de.json",
        "apps/mobile/src/i18n/translations/pt-BR.json",
      ],
      manual: [
        "apps/web/src/i18n/config.json",
        "packages/x/pnpm-lock.yaml",
        "apps/server/src/mcp/McpHttpServer.ts",
      ],
    });
  });
});

describe("mergeLocaleJson", () => {
  it("keeps upstream's edits and adds the fork's keys after their fork neighbour", () => {
    const base = { a: "A", b: "B", gone: "G", dropped: "D" };
    const ours = { a: "A", forkKey: "F", b: "B fork", gone: "G" };
    const theirs = { a: "A up", upKey: "U", b: "B", dropped: "D" };
    const { merged, conflicts } = mergeLocaleJson({ base, ours, theirs });
    expect(conflicts).toEqual([]);
    // gone: upstream deleted it and the fork left it alone. dropped: the fork deleted it.
    expect(Object.entries(merged)).toEqual([
      ["a", "A up"],
      ["forkKey", "F"],
      ["upKey", "U"],
      ["b", "B fork"],
    ]);
  });

  it("reports keys both sides changed apart, or one changed and the other deleted", () => {
    const { conflicts } = mergeLocaleJson({
      base: { both: "x", fork: "x", up: "x", same: "x" },
      ours: { both: "fork", up: "fork edit", same: "y", added: "1" },
      theirs: { both: "up", fork: "x", same: "y", added: "2" },
    });
    // up: upstream deleted a key the fork edited. fork: deleted by the fork only, so it drops.
    expect(conflicts.toSorted()).toEqual(["added", "both", "up"]);
  });

  it("compares structured values and handles an add/add catalog with no base", () => {
    const plural = { one: "1 item", other: "{n} items" };
    expect(
      mergeLocaleJson({ base: null, ours: { p: plural, f: "F" }, theirs: { p: { ...plural } } }),
    ).toEqual({ merged: { p: plural, f: "F" }, conflicts: [] });
  });
});

describe("decideBudgetLabel", () => {
  const forkDev = { claude: 100, codex: 200, mcp: 300 };

  it("labels only when every grown value is upstream's own", () => {
    expect(
      decideBudgetLabel({
        forkDev,
        head: { claude: 120, codex: 200, mcp: 290 },
        upstream: { claude: 120, codex: 210, mcp: 250 },
      }),
    ).toEqual({ label: true, grown: [{ key: "claude", forkDev: 100, head: 120, upstream: 120 }] });
  });

  it("does not label fork growth, no growth, or a missing budget file", () => {
    const upstream = { claude: 120, codex: 200, mcp: 300 };
    expect(
      decideBudgetLabel({ forkDev, head: { claude: 120, codex: 200, mcp: 310 }, upstream }).label,
    ).toBe(false);
    expect(decideBudgetLabel({ forkDev, head: forkDev, upstream }).label).toBe(false);
    expect(decideBudgetLabel({ forkDev: null, head: forkDev, upstream }).label).toBe(false);
  });
});

describe("computeOverlap", () => {
  it("lists the seam entries the range touches with their reason and commits", () => {
    const commitsByFile = parseLogNameOnly(
      "\0aaa fix: one\n\na.ts\nfork-only.ts\n\0bbb feat: two\n\na.ts\nc.ts\n",
    );
    expect(
      computeOverlap({
        rangeFiles: ["a.ts", "c.ts", "fork-only.ts"],
        seamsText: "# header\na.ts  # identity: hook\nb.ts  # jira: route\nc.ts  # x: y # z\n",
        commitsByFile,
      }),
    ).toEqual([
      { path: "a.ts", reason: "identity: hook", commits: ["aaa fix: one", "bbb feat: two"] },
      { path: "c.ts", reason: "x: y # z", commits: ["bbb feat: two"] },
    ]);
  });
});

describe("weld text", () => {
  it("omits attribution lines that are set empty", () => {
    const sha = "f02a14e06561ab3ad9e0d2b8ebf597eb4b1687b2";
    expect(buildMergeMessage({ base: "9f24cac6d42f00", sha, commits: 7 })).toBe(
      "Merge upstream main through f02a14e06561\n\n" +
        "Weld pingdotgg/t3code main 9f24cac6d42f..f02a14e06561 (7 commits) into fork/dev.",
    );
    expect(
      buildMergeMessage({ base: "9f24", sha, commits: 7, modelLine: "Model: m", trailers: "T: x" }),
    ).toMatch(/\n\nModel: m\n\nT: x$/);
  });

  it("keeps the landing instruction when the report is truncated", () => {
    const body = buildPrBody({
      report: "x".repeat(70_000),
      autoResolved: [{ path: "pnpm-lock.yaml", how: "lock" }],
      manual: ["a.ts"],
      forkCommits: [],
    });
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("`a.ts`: resolved by hand");
    expect(body).toContain("Land with `gh pr merge --merge`. Do not squash.");
  });
});
