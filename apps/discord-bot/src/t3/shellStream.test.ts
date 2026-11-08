import {
  ProjectId,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyIntegrationShellStreamItem } from "./shellStream.ts";

const T3CODE_ROOT = "/var/lib/t3/src/t3code";
const SCANNER_ROOT = "/var/lib/t3/src/macs/scanner";

function project(id: string, workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function snapshot(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  snapshotSequence = 1,
): OrchestrationV2ShellSnapshot {
  return {
    schemaVersion: 1,
    snapshotSequence,
    projects,
    threads: [],
    archivedThreads: [],
  };
}

describe("applyIntegrationShellStreamItem", () => {
  it("keeps registered projects when an enrichment snapshot lists only one root", () => {
    const held = snapshot([project("t3code", T3CODE_ROOT), project("scanner", SCANNER_ROOT)]);
    const identity = {
      canonicalKey: "github.com/patroza/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/patroza/t3code.git",
      },
    };

    const next = applyIntegrationShellStreamItem(held, {
      kind: "snapshot",
      snapshot: snapshot([{ ...project("t3code", T3CODE_ROOT), repositoryIdentity: identity }], 4),
      resolvedRepositoryIdentityRoots: [T3CODE_ROOT],
    });

    expect(next?.projects.map((entry) => entry.workspaceRoot)).toEqual([T3CODE_ROOT, SCANNER_ROOT]);
    expect(next?.projects[0]?.repositoryIdentity).toEqual(identity);
    expect(next?.snapshotSequence).toBe(1);
  });

  it("replaces the project list on an authoritative snapshot", () => {
    const held = snapshot([project("t3code", T3CODE_ROOT), project("scanner", SCANNER_ROOT)]);
    const next = applyIntegrationShellStreamItem(held, {
      kind: "snapshot",
      snapshot: snapshot([project("scanner", SCANNER_ROOT)], 2),
    });

    expect(next?.projects.map((entry) => entry.id)).toEqual(["scanner"]);
    expect(next?.snapshotSequence).toBe(2);
  });
});
