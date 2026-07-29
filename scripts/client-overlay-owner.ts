#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface ClientOverlayOwnership {
  readonly id: string;
  readonly branch: string;
  readonly pullRequest: number | null;
  readonly paths: ReadonlyArray<string>;
}

interface ClientOverlayOwnershipManifest {
  readonly overlays: ReadonlyArray<ClientOverlayOwnership>;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

export function pathMatchesOwnershipPattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern.endsWith("/**")) {
    return normalizedPath.startsWith(normalizedPattern.slice(0, -2));
  }
  return normalizedPath === normalizedPattern;
}

export function ownersForPaths(
  overlays: ReadonlyArray<ClientOverlayOwnership>,
  paths: ReadonlyArray<string>,
): ReadonlyArray<ClientOverlayOwnership> {
  return overlays.filter((overlay) =>
    paths.some((path) =>
      overlay.paths.some((pattern) => pathMatchesOwnershipPattern(path, pattern)),
    ),
  );
}

export function readClientOverlayOwnership(sourceRoot: string): ClientOverlayOwnershipManifest {
  const path = NodePath.join(sourceRoot, ".github", "client-overlay-ownership.json");
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as ClientOverlayOwnershipManifest;
}

function main(args: ReadonlyArray<string>): void {
  if (args.length === 0) {
    throw new Error("Usage: pnpm fork:overlay-owner <path> [path...]");
  }
  const sourceRoot = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "..",
  );
  const owners = ownersForPaths(readClientOverlayOwnership(sourceRoot).overlays, args);
  if (owners.length === 0) {
    console.log("fork/changes");
    return;
  }
  for (const owner of owners) {
    if (owner.pullRequest === null) {
      console.log(`${owner.id}: ${owner.branch} (extraction pending)`);
    } else {
      console.log(
        `${owner.id}: PR #${owner.pullRequest} (${owner.branch}); start changes with ` +
          `pnpm fork:stack overlay-start ${owner.pullRequest} <branch>`,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
