// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

const JiraProjectPrefix = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{1,9}$/u)),
    SchemaTransformation.trim().pipe(
      SchemaTransformation.composeTransformation(SchemaTransformation.toUpperCase()),
    ),
  ),
);

// `jiraProjects` is a fork key of t3.json; the upstream project file schema does not know it.
const decodeJiraProjectsField = Schema.decodeExit(
  fromLenientJson(
    Schema.Struct({
      jiraProjects: Schema.optionalKey(
        Schema.Array(JiraProjectPrefix).check(Schema.isMaxLength(20)),
      ),
    }),
  ),
);

function uniquePrefixes(prefixes: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const prefix of prefixes) {
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    found.push(prefix);
  }
  return found;
}

/**
 * Jira prefixes declared in `<workspaceRoot>/t3.json`.
 *
 * A missing file, or a valid file that omits `jiraProjects`, is `[]`: only
 * Atlassian links count. An unreadable or invalid file is `null`, so a refresh
 * does not drop keys already stored for that project.
 */
export function readJiraBareKeyProjects(workspaceRoot: string): readonly string[] | null {
  const filePath = NodePath.join(workspaceRoot, T3_PROJECT_FILE_NAME);
  let contents: string;
  try {
    contents = NodeFS.readFileSync(filePath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return [];
    return null;
  }
  if (parseT3ProjectFile(contents) === null) return null;
  const decoded = decodeJiraProjectsField(contents);
  if (!Exit.isSuccess(decoded)) return null;
  return uniquePrefixes(decoded.value.jiraProjects ?? []);
}

/** Union of prefixes from these workspaces. An unreadable file contributes none. */
export function readJiraBareKeyProjectsForWorkspaceRoots(
  workspaceRoots: ReadonlyArray<string>,
): readonly string[] {
  const found: string[] = [];
  for (const workspaceRoot of workspaceRoots) {
    const prefixes = readJiraBareKeyProjects(workspaceRoot);
    if (prefixes === null) continue;
    found.push(...prefixes);
  }
  return uniquePrefixes(found);
}
