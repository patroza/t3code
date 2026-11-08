// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  readJiraBareKeyProjects,
  readJiraBareKeyProjectsForWorkspaceRoots,
} from "./jiraBareKeyProjects.ts";

function writeProject(root: string, contents: string | null): void {
  NodeFS.mkdirSync(root, { recursive: true });
  if (contents === null) return;
  NodeFS.writeFileSync(NodePath.join(root, "t3.json"), contents, "utf8");
}

describe("readJiraBareKeyProjects", () => {
  it("reads every prefix a repository lists", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-jira-file-"));
    writeProject(root, '{ "jiraProjects": ["sa", "CFG", "SA"] }\n');
    expect(readJiraBareKeyProjects(root)).toEqual(["SA", "CFG"]);
    expect(readJiraBareKeyProjects(`${root}/`)).toEqual(["SA", "CFG"]);
  });

  it("treats a missing file or omitted field as links only", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-jira-file-"));
    expect(readJiraBareKeyProjects(root)).toEqual([]);
    writeProject(root, '{ "defaultThreadEnvMode": "worktree" }\n');
    expect(readJiraBareKeyProjects(root)).toEqual([]);
    writeProject(root, '{ "jiraProjects": [] }\n');
    expect(readJiraBareKeyProjects(root)).toEqual([]);
  });

  it("returns null when the file cannot be trusted", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-jira-file-"));
    writeProject(root, "{ not json");
    expect(readJiraBareKeyProjects(root)).toBeNull();
    writeProject(root, '{ "jiraProjects": ["SA-465"] }\n');
    expect(readJiraBareKeyProjects(root)).toBeNull();
    writeProject(root, '{ "jiraProjects": "SA" }\n');
    expect(readJiraBareKeyProjects(root)).toBeNull();
  });

  it("unions prefixes across repositories and skips an unreadable file", () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-jira-roots-"));
    const scanner = NodePath.join(parent, "scanner");
    const configurator = NodePath.join(parent, "configurator");
    const broken = NodePath.join(parent, "broken");
    writeProject(scanner, '{ "jiraProjects": ["SA"] }\n');
    writeProject(configurator, '{ "jiraProjects": ["CFG", "SA"] }\n');
    writeProject(broken, "{ not json");
    expect(readJiraBareKeyProjectsForWorkspaceRoots([scanner, configurator, broken])).toEqual([
      "SA",
      "CFG",
    ]);
    expect(readJiraBareKeyProjectsForWorkspaceRoots([NodePath.join(parent, "missing")])).toEqual(
      [],
    );
  });
});
