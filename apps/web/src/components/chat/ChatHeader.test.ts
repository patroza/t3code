import { EnvironmentId } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off - existence contract reads source text on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { resolveRenameCommit, shouldShowOpenInPicker } from "./ChatHeader";

const chatHeaderSource = NodeFS.readFileSync(
  NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "ChatHeader.tsx"),
  "utf8",
);

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(true);
  });

  it("shows the picker for remote environments in deep-link mode", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(true);
  });

  it("shows the picker's unavailable state for remote environments without an SSH route", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
        remoteOpenMode: "remote-unavailable",
      }),
    ).toBe(true);
  });

  it("hides the picker for non-primary local backends", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(false);
  });
});

describe("ChatHeader AI usage + host resources surface (anti stack-drop)", () => {
  it("still wires conversation-level usage status and host resource gauges", () => {
    // Stack product rejoins have previously re-landed pure helpers + settings
    // HostResourceStatus while dropping the thread-header surfaces. Keep the
    // JSX markers co-located with the pure gates so that cannot pass silently.
    expect(chatHeaderSource).toContain("useAiUsageSnapshot");
    expect(chatHeaderSource).toContain("resolveDriverUsage");
    expect(chatHeaderSource).toContain('aria-label="provider usage status"');
    expect(chatHeaderSource).toContain("AiUsageStats");
    expect(chatHeaderSource).toContain("HostResourceStatus");
    expect(chatHeaderSource).toContain("isLocalConnectionTarget");
    expect(chatHeaderSource).toContain("activeThreadDriverKind");
    expect(chatHeaderSource).toContain("activeThreadModel");
  });
});

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});
