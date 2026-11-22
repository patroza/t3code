import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { checkForkSeams, parseSeams } from "./check-fork-seams.mjs";

describe("parseSeams", () => {
  it("reads paths and flags missing reasons, duplicates, and unsorted entries", () => {
    expect(parseSeams("# header\n\na.ts  # x: hook\nb.ts  # y: hook\n")).toEqual({
      entries: ["a.ts", "b.ts"],
      problems: [],
    });
    expect(parseSeams("b.ts  # y\na.ts\nb.ts  # y\n").problems).toEqual([
      'line 2: a.ts has no "# <feature>: <why>" reason',
      "line 3: b.ts is listed twice",
      "entries are not sorted (byte order); sort the non-comment lines",
    ]);
  });
});

describe("checkForkSeams", () => {
  const withRepo = (fn) => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-seams-"));
    const git = (...args) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    const write = (path, text) => NodeFS.writeFileSync(NodePath.join(cwd, path), text);
    try {
      git("init", "--quiet", "-b", "upstream");
      return fn({ cwd, git, write });
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  };

  it("compares HEAD with the merge base, not with the moving upstream tip", () =>
    withRepo(({ cwd, git, write }) => {
      for (const name of ["hooked.ts", "edited.ts", "deleted.ts", "stale.ts", "later.ts"]) {
        write(name, "upstream\n");
      }
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
      git("checkout", "--quiet", "-b", "fork");
      write("hooked.ts", "fork hook\n");
      write("edited.ts", "fork edit\n");
      write("fork-only.ts", "fork\n");
      NodeFS.rmSync(NodePath.join(cwd, "deleted.ts"));
      git("add", "-A");
      git("commit", "--quiet", "-m", "fork");
      git("checkout", "--quiet", "upstream");
      write("later.ts", "upstream moved on\n");
      git("commit", "--quiet", "-am", "upstream later");
      git("checkout", "--quiet", "fork");

      const result = checkForkSeams({
        cwd,
        upstreamRef: "upstream",
        seamsText: "fork-only.ts  # f: x\nhooked.ts  # f: hook\nstale.ts  # f: gone\n",
      });
      expect(result.unlisted).toEqual(["deleted.ts", "edited.ts"]);
      expect(result.stale).toEqual(["stale.ts"]);
      expect(result.notUpstream).toEqual(["fork-only.ts"]);
    }));
});
