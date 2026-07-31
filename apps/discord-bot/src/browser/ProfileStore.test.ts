// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  acquireProfileLock,
  listProfiles,
  profilePaths,
  validateProfileName,
  writeProfileMetadata,
} from "./ProfileStore.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-browser-profile-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("browser profile store", () => {
  it("rejects path-like profile names", () => {
    expect(() => validateProfileName("../credentials")).toThrow(/Profile names/);
    expect(() => validateProfileName("Work Account")).toThrow(/Profile names/);
    expect(validateProfileName("github-work")).toBe("github-work");
  });

  it("prevents concurrent profile use", async () => {
    const paths = profilePaths(await temporaryDirectory(), "github-work");
    const release = await acquireProfileLock(paths);
    await expect(acquireProfileLock(paths)).rejects.toThrow(/is in use/);
    await release();
    const releaseAgain = await acquireProfileLock(paths);
    await releaseAgain();
  });

  it("stores only profile metadata in the index", async () => {
    const dataDir = await temporaryDirectory();
    const paths = profilePaths(dataDir, "github-work");
    await writeProfileMetadata(paths, {
      name: "github-work",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      browserExecutablePath: "/usr/bin/chromium",
    });
    await NodeFSP.writeFile(NodePath.join(paths.userDataDir, "Cookies"), "secret");

    await expect(listProfiles(dataDir)).resolves.toEqual([
      expect.objectContaining({ name: "github-work", browserExecutablePath: "/usr/bin/chromium" }),
    ]);
  });
});
