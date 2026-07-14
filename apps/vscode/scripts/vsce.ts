// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Runs vsce with README links pinned to the current commit.
 *
 * vsce cannot infer that this extension lives in a monorepo subdirectory, so
 * relative README links are rewritten against --baseContentUrl/--baseImagesUrl.
 * Pinning those to the commit rather than a branch keeps a published version's
 * README pointing at the tree it was built from: the screenshot still resolves
 * after files move on main, and a version published before its commit reaches
 * main is not left with a broken image.
 */

const extensionRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);

const git = (...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", args, { cwd: extensionRoot, encoding: "utf8" }).trim();

const fail = (message: string): never => {
  console.error(`vsce: ${message}`);
  process.exit(1);
};

const manifest: unknown = JSON.parse(
  NodeFS.readFileSync(NodePath.join(extensionRoot, "package.json"), "utf8"),
);
if (typeof manifest !== "object" || manifest === null) fail("package.json is not an object.");
const repository = (manifest as { repository?: { url?: string; directory?: string } }).repository;
const repositoryUrl = repository?.url;
const directory = repository?.directory;
if (repositoryUrl === undefined || directory === undefined) {
  fail("package.json needs repository.url and repository.directory to pin README links.");
}

const slug = /github\.com\/(?<slug>[^/]+\/[^/]+?)(?:\.git)?$/u.exec(repositoryUrl!)?.groups?.slug;
if (slug === undefined) fail(`Cannot read a GitHub slug from repository.url "${repositoryUrl!}".`);

const commit = git("rev-parse", "HEAD");

// A commit that has not been pushed produces links that 404 for everyone else,
// and a published version's README cannot be corrected afterwards.
if (git("branch", "--remotes", "--contains", commit) === "") {
  fail(
    `Commit ${commit} is not on any remote branch, so pinned README links would 404.\n` +
      "Push the branch before packaging or publishing.",
  );
}
if (git("status", "--porcelain") !== "") {
  console.warn(
    `vsce: warning: the working tree is dirty. README links pin to ${commit.slice(0, 9)}, which does not include uncommitted changes.`,
  );
}

const [command, ...rest] = process.argv.slice(2);
if (command === undefined) fail("Usage: node scripts/vsce.ts <package|publish> [args...]");

const args = [
  command!,
  "--no-dependencies",
  "--baseContentUrl",
  `https://github.com/${slug!}/blob/${commit}/${directory!}`,
  "--baseImagesUrl",
  `https://raw.githubusercontent.com/${slug!}/${commit}/${directory!}`,
  ...rest,
];
console.log(`vsce: pinning README links to ${commit.slice(0, 9)}`);
NodeChildProcess.execFileSync("vsce", args, { cwd: extensionRoot, stdio: "inherit" });
