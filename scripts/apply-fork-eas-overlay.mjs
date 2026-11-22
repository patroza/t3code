#!/usr/bin/env node
// Fork-only. Applies apps/mobile/eas.fork.json to upstream's apps/mobile/eas.json in the working
// tree, so the fork's EAS identity never lives in the upstream file. Fork mobile workflows run it
// right after checkout; EAS archives include the uncommitted result. With GITHUB_ENV set, the
// identity is also exported to later steps, which evaluate app.config.ts on the runner.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Objects merge key by key; anything else in the patch replaces the base value. */
export const deepMerge = (base, patch) => {
  if (!isObject(base) || !isObject(patch)) return patch;
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) merged[key] = deepMerge(base[key], value);
  return merged;
};

/**
 * @param {Record<string, any>} eas upstream eas.json
 * @param {{ env?: Record<string, string>, eas?: Record<string, any> }} fork eas.fork.json
 */
export const applyForkEasOverlay = (eas, fork) => {
  const next = deepMerge(eas, fork.eas ?? {});
  const env = fork.env ?? {};
  // Profiles that extend another inherit its env; writing it again would override their own.
  for (const [name, profile] of Object.entries(next.build ?? {})) {
    if (!isObject(profile) || "extends" in profile) continue;
    next.build[name] = { ...profile, env: { ...profile.env, ...env } };
  }
  return next;
};

const main = () => {
  const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const easPath = NodePath.join(root, "apps/mobile/eas.json");
  const fork = JSON.parse(
    NodeFS.readFileSync(NodePath.join(root, "apps/mobile/eas.fork.json"), "utf8"),
  );
  const eas = JSON.parse(NodeFS.readFileSync(easPath, "utf8"));
  NodeFS.writeFileSync(easPath, `${JSON.stringify(applyForkEasOverlay(eas, fork), null, 2)}\n`);
  const githubEnv = NodeProcess.env.GITHUB_ENV;
  if (githubEnv) {
    const lines = Object.entries(fork.env ?? {}).map(([name, value]) => `${name}=${value}\n`);
    NodeFS.appendFileSync(githubEnv, lines.join(""));
  }
  console.log(`apply-fork-eas-overlay: applied apps/mobile/eas.fork.json to ${easPath}`);
};

if (
  NodeProcess.argv[1] &&
  NodePath.resolve(NodeProcess.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main();
}
