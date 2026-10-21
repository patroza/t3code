// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";

// Replace the host's ~/.gitconfig for every git child the suite spawns.
// GIT_CONFIG_COUNT overrides local repo config too, which breaks fixtures
// that enable commit.gpgSign or commit an executable `.githooks/post-checkout`.
process.env.GIT_CONFIG_GLOBAL = `${import.meta.dirname}/vitest.gitconfig`;
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.GIT_CONFIG_COUNT;

// Without Homebrew git, macOS resolves `git` to /usr/bin/git, an xcrun shim that costs
// about 8 ms per spawn against 3 ms for the real binary. Git-heavy files such as
// GitVcsDriverCore.test.ts and GitManager.test.ts run twice as fast with the real one.
if (HostProcess.Platform.defaultValue() === "darwin") {
  const gitOnPath = (process.env.PATH ?? "")
    .split(NodePath.delimiter)
    .map((dir) => NodePath.join(dir, "git"))
    .find((candidate) => NodeFS.existsSync(candidate));
  if (gitOnPath === "/usr/bin/git") {
    try {
      const realGit = NodeChildProcess.execFileSync("xcrun", ["-f", "git"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (NodePath.isAbsolute(realGit)) {
        process.env.PATH = `${NodePath.dirname(realGit)}${NodePath.delimiter}${process.env.PATH}`;
      }
    } catch {}
  }
}
