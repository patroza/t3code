#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot catalog tool; synchronous Node APIs keep it small.
// Fork-only. Fork UI strings live in each app's `src/i18n/fork-translations/`, so upstream's
// catalogs stay byte-identical to upstream. A key belongs to the fork when upstream's en.json
// lacks it. `generate` (an app's `i18n:generate`) writes only the fork catalogs; `check` (root
// `i18n:check`) replaces scripts/i18n-check.ts and validates both layers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Desktop only depends on gt-i18n, so the gt CLI hides `generate` there; its script adds it back.
const GENERATE: Record<string, readonly [string, ...string[]]> = {
  "apps/web": ["node_modules/.bin/gt", "generate"],
  "apps/mobile": ["node_modules/.bin/gt", "generate"],
  "apps/desktop": [process.execPath, "scripts/i18n-generate.mjs"],
};

type Catalog = Record<string, unknown>;
const readJson = (file: string) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const writeJson = (file: string, value: unknown) =>
  NodeFS.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const missingFrom = (from: Catalog, catalog: Catalog) =>
  Object.keys(from).filter((key) => !Object.hasOwn(catalog, key));
// JSX entries (`<T>`) are arrays and objects, so values compare by their JSON text.
const sameText = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

const root = NodePath.resolve(import.meta.dirname, "..");

interface App {
  readonly app: string;
  readonly appDir: string;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  readonly upstreamDir: string;
  readonly forkDir: string;
  readonly generated: Catalog;
}

/** Runs the same scan as `gt generate`, writing only the source catalog to a temp dir. */
const scanApp = (app: string): App => {
  const [command, ...args] = GENERATE[app]!;
  const appDir = NodePath.join(root, app);
  const config = readJson(NodePath.join(appDir, "gt.config.json"));
  const upstreamDir = NodePath.join(appDir, NodePath.dirname(config.files.gt.output));
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-i18n-"));
  try {
    const tmpConfig = NodePath.join(tmp, "gt.config.json");
    writeJson(tmpConfig, {
      ...config,
      locales: [],
      files: { gt: { output: `${tmp}/[locale].json` } },
    });
    const gt = NodeChildProcess.spawnSync(command, [...args, "--config", tmpConfig], {
      cwd: appDir,
      encoding: "utf8",
    });
    if (gt.status !== 0) throw new Error(`${app}: gt generate failed\n${gt.stdout}${gt.stderr}`);
    return {
      app,
      appDir,
      defaultLocale: config.defaultLocale,
      locales: config.locales,
      upstreamDir,
      forkDir: NodePath.join(upstreamDir, "..", "fork-translations"),
      generated: readJson(NodePath.join(tmp, `${config.defaultLocale}.json`)),
    };
  } finally {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  }
};

const readCatalog = (dir: string, locale: string): Catalog | undefined => {
  const file = NodePath.join(dir, `${locale}.json`);
  return NodeFS.existsSync(file) ? readJson(file) : undefined;
};

/** Keeps existing fork translations, fills new keys with English, and drops stale ones. */
const generate = (app: App) => {
  const upstream: Catalog = readCatalog(app.upstreamDir, app.defaultLocale) ?? {};
  const fork = Object.fromEntries(
    Object.entries(app.generated).filter(([key]) => !Object.hasOwn(upstream, key)),
  );
  NodeFS.mkdirSync(app.forkDir, { recursive: true });
  writeJson(NodePath.join(app.forkDir, `${app.defaultLocale}.json`), fork);
  for (const locale of app.locales) {
    const existing = readCatalog(app.forkDir, locale) ?? {};
    writeJson(
      NodePath.join(app.forkDir, `${locale}.json`),
      Object.fromEntries(
        Object.entries(fork).map(([key, text]) => [
          key,
          Object.hasOwn(existing, key) ? existing[key] : text,
        ]),
      ),
    );
  }
  console.log(`${app.app}: ${Object.keys(fork).length} fork strings in ${app.forkDir}`);
};

const check = (app: App): string[] => {
  const problems: string[] = [];
  const upstream: Catalog = readCatalog(app.upstreamDir, app.defaultLocale) ?? {};
  const fork: Catalog = readCatalog(app.forkDir, app.defaultLocale) ?? {};
  for (const [key, text] of Object.entries(app.generated)) {
    const committed = Object.hasOwn(upstream, key) ? upstream[key] : fork[key];
    if (committed === undefined) {
      problems.push(`${app.app}: ${key} ${JSON.stringify(text)} is in no catalog`);
    } else if (!sameText(committed, text)) {
      problems.push(
        `${app.app}: catalog has ${key} ${JSON.stringify(committed)}, source says ${JSON.stringify(text)}`,
      );
    }
  }
  // Upstream keys the fork's source lacks are tolerated: only an upstream edit could drop them.
  for (const key of missingFrom(fork, app.generated)) {
    problems.push(`${app.app}: fork key ${key} ${JSON.stringify(fork[key])} is stale`);
  }
  for (const key of Object.keys(fork).filter((key) => Object.hasOwn(upstream, key))) {
    problems.push(`${app.app}: fork key ${key} is already in upstream's catalog`);
  }
  const layers = [
    { dir: app.upstreamDir, source: upstream },
    ...(NodeFS.existsSync(app.forkDir) ? [{ dir: app.forkDir, source: fork }] : []),
  ];
  for (const { dir, source } of layers) {
    const name = NodePath.relative(root, dir);
    for (const locale of app.locales) {
      const catalog = readCatalog(dir, locale);
      if (catalog === undefined) {
        problems.push(`${name}/${locale}.json is missing`);
        continue;
      }
      for (const key of missingFrom(source, catalog)) {
        problems.push(`${name}/${locale}.json is missing ${key} ${JSON.stringify(source[key])}`);
      }
      for (const key of missingFrom(catalog, source)) {
        problems.push(`${name}/${locale}.json has ${key}, which its en.json lacks`);
      }
    }
  }
  return problems;
};

const [command, app = NodePath.relative(root, process.cwd())] = process.argv.slice(2);
if (command === "generate" && Object.hasOwn(GENERATE, app)) {
  generate(scanApp(app));
} else if (command === "check") {
  const problems = Object.keys(GENERATE).flatMap((app) => check(scanApp(app)));
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(
      "\nRun `vp run i18n:generate` in the app, then translate any new keys in every fork-translations catalog.",
    );
    process.exitCode = 1;
  } else {
    console.log(`i18n catalogs match the source in ${Object.keys(GENERATE).join(", ")}.`);
  }
} else {
  console.error("Usage: fork-i18n.ts check | fork-i18n.ts generate [apps/<app>]");
  process.exitCode = 1;
}
