import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  assertOverlaysReadyForCompose,
  planOverlayRebase,
  tryResolveThreadListItemsImportConflict,
  type OverlayRebaseResult,
} from "./rebase-integration-overlays.ts";
import { StackError } from "./rebase-pr-stack.ts";

function writeConflictedThreadListItems(repoDir: string, contents: string): string {
  const relativePath = "apps/mobile/src/features/threads/thread-list-items.tsx";
  const absolutePath = NodePath.join(repoDir, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(absolutePath), { recursive: true });
  NodeFS.writeFileSync(absolutePath, contents, "utf8");
  return absolutePath;
}

describe("planOverlayRebase", () => {
  it("skips when fork/changes is already an ancestor of the overlay tip", () => {
    expect(
      planOverlayRebase({
        number: 173,
        branch: "fork/desktop",
        tip: "tip1",
        newBase: "base1",
        isNewBaseAncestorOfTip: true,
        mergeBaseWithNewBase: "base1",
      }),
    ).toMatchObject({ action: "skip-already-based" });
  });

  it("plans a rebase using the merge-base with the new changes tip", () => {
    expect(
      planOverlayRebase({
        number: 174,
        branch: "fork/discord",
        tip: "tip2",
        newBase: "base2",
        isNewBaseAncestorOfTip: false,
        mergeBaseWithNewBase: "oldBase2",
      }),
    ).toEqual({
      number: 174,
      branch: "fork/discord",
      tip: "tip2",
      newBase: "base2",
      oldBase: "oldBase2",
      action: "rebase",
    });
  });

  it("errors when there is no usable merge-base", () => {
    expect(
      planOverlayRebase({
        number: 175,
        branch: "fork/vscode",
        tip: "tip3",
        newBase: "base3",
        isNewBaseAncestorOfTip: false,
        mergeBaseWithNewBase: null,
      }).action,
    ).toBe("error");
  });
});

describe("tryResolveThreadListItemsImportConflict", () => {
  it("merges identity + settled-row imports from a known conflict block", () => {
    const repoDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "overlay-import-"));
    NodeChildProcess.spawnSync("git", ["init", "--quiet"], { cwd: repoDir });
    const absolutePath = writeConflictedThreadListItems(
      repoDir,
      [
        'import { foo } from "./foo";',
        "<<<<<<< HEAD",
        'import { resolveSettledRowTimestamp, resolveThreadStatus } from "./threadPresentation";',
        "=======",
        'import { ThreadIdentityLeading } from "../identity/ParticipantStack";',
        'import { resolveThreadStatus } from "./threadPresentation";',
        ">>>>>>> identity",
        "export const x = 1;",
        "",
      ].join("\n"),
    );

    expect(tryResolveThreadListItemsImportConflict(repoDir)).toBe(true);
    const resolved = NodeFS.readFileSync(absolutePath, "utf8");
    expect(resolved).toContain(
      'import { ThreadIdentityLeading } from "../identity/ParticipantStack";',
    );
    expect(resolved).toContain(
      'import { resolveSettledRowTimestamp, resolveThreadStatus } from "./threadPresentation";',
    );
    expect(resolved).not.toContain("<<<<<<<");
    expect(resolved).not.toContain(">>>>>>>");
  });

  it("leaves unrelated conflict markers alone", () => {
    const repoDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "overlay-import-"));
    writeConflictedThreadListItems(
      repoDir,
      ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> other", ""].join("\n"),
    );
    expect(tryResolveThreadListItemsImportConflict(repoDir)).toBe(false);
  });
});

describe("assertOverlaysReadyForCompose", () => {
  it("accepts already-based skips", () => {
    const result: OverlayRebaseResult = {
      updated: [],
      skipped: [
        {
          number: 173,
          branch: "fork/desktop",
          reason: "already based on fork/changes",
        },
      ],
      conflicts: [],
    };
    expect(() => assertOverlaysReadyForCompose(result, "fork/changes")).not.toThrow();
  });

  it("throws on conflicts", () => {
    const result: OverlayRebaseResult = {
      updated: [],
      skipped: [],
      conflicts: [{ number: 174, branch: "fork/discord", message: "conflict: apps/x.ts" }],
    };
    expect(() => assertOverlaysReadyForCompose(result, "fork/changes")).toThrow(StackError);
    expect(() => assertOverlaysReadyForCompose(result, "fork/changes")).toThrow(/174/);
  });
});
