// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as NodeProcess from "node:process";
import * as NodeReadlinePromises from "node:readline/promises";
import * as NodeURL from "node:url";

import { chromium } from "playwright-core";

import {
  acquireProfileLock,
  clearProfile,
  ensureProfileDirectories,
  listProfiles,
  profilePaths,
  readProfileMetadata,
  writeProfileMetadata,
  type BrowserProfileMetadata,
} from "./browser/ProfileStore.ts";

interface ParsedArguments {
  readonly command: string | undefined;
  readonly profile: string | undefined;
  readonly options: ReadonlyMap<string, string | true>;
}

export function parseArguments(argv: ReadonlyArray<string>): ParsedArguments {
  const [command, ...tail] = argv;
  const profile = tail[0]?.startsWith("--") === false ? tail.shift() : undefined;
  const rest = tail;
  const options = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]!;
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(item.slice(2), next);
      index += 1;
    } else {
      options.set(item.slice(2), true);
    }
  }
  return { command, profile, options };
}

function option(input: ParsedArguments, name: string): string | undefined {
  const value = input.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function required(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === "") throw new Error(message);
  return value;
}

function matchesExpectedUrl(actual: string, expected: string): boolean {
  const expression = new RegExp(
    `^${expected.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*")}$`,
  );
  return expression.test(actual);
}

async function setup(input: ParsedArguments, dataDir: string, executablePath: string) {
  const name = required(input.profile, "setup requires a profile name");
  const setupUrl = option(input, "url") ?? "about:blank";
  const verifyUrl = option(input, "verify-url");
  const expectUrl = option(input, "expect-url");
  const paths = profilePaths(dataDir, name);
  await ensureProfileDirectories(paths);
  const release = await acquireProfileLock(paths);
  try {
    const context = await chromium.launchPersistentContext(paths.userDataDir, {
      executablePath,
      headless: false,
      viewport: { width: 1_440, height: 900 },
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      if (setupUrl !== "about:blank") await page.goto(setupUrl, { waitUntil: "domcontentloaded" });
      const prompt = NodeReadlinePromises.createInterface({
        input: NodeProcess.stdin,
        output: NodeProcess.stdout,
      });
      try {
        await prompt.question(
          "Complete login in the browser, then press Enter to verify and save. ",
        );
      } finally {
        prompt.close();
      }

      let verifiedAt: string | undefined;
      if (verifyUrl !== undefined && expectUrl !== undefined) {
        await page.goto(verifyUrl, { waitUntil: "domcontentloaded" });
        if (!matchesExpectedUrl(page.url(), expectUrl)) {
          throw new Error(`Verification failed: ${page.url()} does not match ${expectUrl}`);
        }
        verifiedAt = new Date().toISOString();
      }
      const now = new Date().toISOString();
      let previous: BrowserProfileMetadata | undefined;
      try {
        previous = await readProfileMetadata(paths);
      } catch {
        previous = undefined;
      }
      await writeProfileMetadata(paths, {
        name,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        setupUrl,
        ...(verifyUrl === undefined ? {} : { verifyUrl }),
        ...(expectUrl === undefined ? {} : { expectUrl }),
        ...(verifiedAt === undefined ? {} : { verifiedAt }),
        browserExecutablePath: executablePath,
      });
      NodeProcess.stdout.write(
        verifiedAt === undefined
          ? `Saved unverified profile ${name}. Add --verify-url and --expect-url for login checks.\n`
          : `Saved and verified profile ${name}.\n`,
      );
    } finally {
      await context.close();
    }
  } finally {
    await release();
  }
}

async function verify(input: ParsedArguments, dataDir: string, executablePath: string) {
  const name = required(input.profile, "verify requires a profile name");
  const paths = profilePaths(dataDir, name);
  const metadata = await readProfileMetadata(paths);
  if (metadata.browserExecutablePath !== executablePath) {
    throw new Error(
      `Profile was created with ${metadata.browserExecutablePath}; use the same executable.`,
    );
  }
  const verifyUrl = required(metadata.verifyUrl, "Profile has no verification URL; rerun setup.");
  const expectUrl = required(metadata.expectUrl, "Profile has no expected URL; rerun setup.");
  const release = await acquireProfileLock(paths);
  try {
    const context = await chromium.launchPersistentContext(paths.userDataDir, {
      executablePath,
      headless: true,
      viewport: { width: 1_440, height: 900 },
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(verifyUrl, { waitUntil: "domcontentloaded" });
      if (!matchesExpectedUrl(page.url(), expectUrl)) {
        throw new Error(`Profile ${name} is no longer authenticated; rerun headed setup.`);
      }
      await writeProfileMetadata(paths, {
        ...metadata,
        updatedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
      });
      NodeProcess.stdout.write(`Profile ${name} is authenticated.\n`);
    } finally {
      await context.close();
    }
  } finally {
    await release();
  }
}

function usage(): never {
  throw new Error(
    "Usage: browser-profile <setup|verify|list|clear> [name] [--data-dir PATH] [--executable-path PATH]",
  );
}

async function main() {
  const input = parseArguments(NodeProcess.argv.slice(2));
  const dataDir =
    option(input, "data-dir") ?? NodeProcess.env["T3_DISCORD_BOT_DATA_DIR"] ?? "~/.t3/discord-bot";
  if (input.command === "list") {
    const profiles = await listProfiles(dataDir);
    if (profiles.length === 0) NodeProcess.stdout.write("No browser profiles configured.\n");
    for (const profile of profiles) {
      NodeProcess.stdout.write(
        `${profile.name}\t${profile.verifiedAt ? `verified ${profile.verifiedAt}` : "unverified"}\n`,
      );
    }
    return;
  }
  if (input.command === "clear") {
    if (input.options.get("yes") !== true) throw new Error("clear requires --yes");
    await clearProfile(dataDir, required(input.profile, "clear requires a profile name"));
    NodeProcess.stdout.write(`Cleared profile ${input.profile}.\n`);
    return;
  }
  const executablePath = required(
    option(input, "executable-path") ?? NodeProcess.env["T3_DISCORD_BROWSER_EXECUTABLE_PATH"],
    "Set --executable-path or T3_DISCORD_BROWSER_EXECUTABLE_PATH.",
  );
  if (input.command === "setup") return setup(input, dataDir, executablePath);
  if (input.command === "verify") return verify(input, dataDir, executablePath);
  return usage();
}

if (
  NodeProcess.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(NodeProcess.argv[1]).href
) {
  main().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    NodeProcess.stderr.write(`browser-profile: ${message}\n`);
    NodeProcess.exit(1);
  });
}
