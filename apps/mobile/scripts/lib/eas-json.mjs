#!/usr/bin/env node
// Tolerant reader for `eas ... --json` output.
//
// EAS CLI prints human-readable notices on stdout even in `--json` mode. The
// one that broke every production deploy comes from
// `eas fingerprint:generate --environment production` when that EAS
// environment holds no plain-text/sensitive variables:
//
//   No environment variables with visibility "Plain text" and "Sensitive"
//   found for the "production" environment on EAS.
//   {"hash":"...","sources":[...]}
//
// A bare `JSON.parse(stdin)` dies on the notice ("Unexpected token 'N'"), so
// pull the first well-formed JSON value out of the stream instead of trusting
// the whole pipe.
//
// Usage: <eas command> --json | node scripts/lib/eas-json.mjs <mode>

import * as NodeURL from "node:url";

const OPENERS = new Set(["{", "["]);
const CLOSERS = new Map([
  ["{", "}"],
  ["[", "]"],
]);

/** Index just past the JSON value opening at `start`, or -1 when unbalanced. */
function findValueEnd(text, start) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (OPENERS.has(ch)) {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      const opener = stack.pop();
      if (opener === undefined || CLOSERS.get(opener) !== ch) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** First parseable JSON object/array in `raw`, or undefined when there is none. */
export function extractJson(raw) {
  const text = String(raw ?? "");
  for (let i = 0; i < text.length; i++) {
    if (!OPENERS.has(text[i])) continue;
    const end = findValueEnd(text, i);
    if (end === -1) continue;
    try {
      return JSON.parse(text.slice(i, end));
    } catch {
      // A brace inside a notice line is not JSON — keep scanning.
    }
  }
  return undefined;
}

/** Statuses whose build can still serve an OTA for its runtime version. */
const USABLE_BUILD_STATUSES = new Set(["NEW", "IN_QUEUE", "IN_PROGRESS", "FINISHED"]);

export function pickFingerprintHash(raw) {
  const value = extractJson(raw);
  if (value === undefined || value === null || Array.isArray(value)) return undefined;
  const hash = value.hash ?? value.fingerprintHash;
  return hash ? String(hash) : undefined;
}

export function pickUsableBuildId(raw) {
  const builds = extractJson(raw);
  if (!Array.isArray(builds)) return undefined;
  const build = builds.find((b) =>
    USABLE_BUILD_STATUSES.has(
      String(b?.status ?? "")
        .toUpperCase()
        .replaceAll("-", "_"),
    ),
  );
  return build?.id ? String(build.id) : undefined;
}

export function pickLatestFinishedRuntime(raw) {
  const builds = extractJson(raw);
  if (!Array.isArray(builds)) return undefined;
  const runtime = builds[0]?.runtimeVersion;
  return runtime ? String(runtime) : undefined;
}

// `required` modes fail the deploy when nothing usable came back; the build
// lookups stay lenient because "no build yet" is a normal, handled outcome.
const MODES = new Map([
  ["fingerprint-hash", { pick: pickFingerprintHash, required: true }],
  ["usable-build-id", { pick: pickUsableBuildId, required: false }],
  ["latest-finished-runtime", { pick: pickLatestFinishedRuntime, required: false }],
]);

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const mode = process.argv[2];
  const handler = MODES.get(mode);
  if (!handler) {
    console.error(
      `eas-json: unknown mode ${JSON.stringify(mode)}; expected one of ${[...MODES.keys()].join(", ")}`,
    );
    process.exit(2);
  }

  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;

  const value = handler.pick(raw);
  if (value === undefined) {
    if (handler.required) {
      console.error(`eas-json: ${mode} found no value in EAS output:`, raw.slice(0, 500));
      process.exit(1);
    }
  } else {
    process.stdout.write(value);
  }
}
