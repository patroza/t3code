// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  jiraProjectsForWorkspaceRoot,
  loadProjectAliasesFromFileSync,
  normalizeJiraProjectPrefixes,
  normalizeProjectAliasShortName,
  parseProjectAliasesDocument,
  parseSimpleAliasesYaml,
} from "./projectAliases.ts";

describe("normalizeProjectAliasShortName", () => {
  it("normalizes valid short names", () => {
    expect(normalizeProjectAliasShortName("Example-Project")).toBe("example-project");
    expect(normalizeProjectAliasShortName("  t3-code  ")).toBe("t3-code");
  });

  it("rejects invalid short names", () => {
    expect(normalizeProjectAliasShortName("")).toBeNull();
    expect(normalizeProjectAliasShortName("Macs_Scanner")).toBeNull();
  });
});

describe("parseProjectAliasesDocument", () => {
  it("parses flat path map", () => {
    const aliases = parseProjectAliasesDocument({
      "example-project": "/home/user/projects/example-project",
      "t3-code": "~/pj/t3code",
    });
    expect(aliases.map((entry) => entry.shortName)).toEqual(["example-project", "t3-code"]);
    expect(aliases[0]?.workspaceRoot).toBe("/home/user/projects/example-project");
    expect(aliases[1]?.workspaceRoot.endsWith("/pj/t3code")).toBe(true);
  });

  it("parses structured aliases map", () => {
    const aliases = parseProjectAliasesDocument({
      aliases: {
        "example-project": { workspaceRoot: "/tmp/scanner" },
      },
    });
    expect(aliases).toEqual([{ shortName: "example-project", workspaceRoot: "/tmp/scanner" }]);
  });

  it("reads jira project prefixes for one host project", () => {
    const aliases = parseProjectAliasesDocument({
      aliases: {
        "macs-scanner": { workspaceRoot: "/tmp/scanner", jiraProjects: ["SA"] },
        "macs-configurator": { workspaceRoot: "/tmp/configurator", jiraProjects: "CFG" },
        skunkworks: { workspaceRoot: "/tmp/skunkworks" },
      },
    });
    expect(jiraProjectsForWorkspaceRoot(aliases, "/tmp/scanner")).toEqual(["SA"]);
    expect(jiraProjectsForWorkspaceRoot(aliases, "/tmp/configurator/")).toEqual(["CFG"]);
    expect(jiraProjectsForWorkspaceRoot(aliases, "/tmp/skunkworks")).toEqual([]);
    expect(normalizeJiraProjectPrefixes("sa, CFG")).toEqual(["SA", "CFG"]);
  });

  it("parses a Discord mirror channel for GitHub-created threads", () => {
    const aliases = parseProjectAliasesDocument({
      aliases: {
        "t3-code": {
          workspaceRoot: "/tmp/t3code",
          discordChannelId: "123456789",
        },
      },
    });
    expect(aliases).toEqual([
      {
        shortName: "t3-code",
        workspaceRoot: "/tmp/t3code",
        discordChannelId: "123456789",
      },
    ]);
  });
});

describe("loadProjectAliasesFromFileSync", () => {
  it("loads yaml files", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bot-aliases-"));
    const yamlPath = NodePath.join(dir, "aliases.yaml");
    await NodeFSP.writeFile(
      yamlPath,
      [
        "skunkworks: /tmp/skunkworks",
        "macs-scanner:",
        "  workspaceRoot: /tmp/scanner",
        "  jiraProjects: SA",
        "macs-configurator:",
        "  workspaceRoot: /tmp/configurator",
        "  jiraProjects: CFG",
        "",
      ].join("\n"),
      "utf8",
    );
    const aliases = loadProjectAliasesFromFileSync(yamlPath);
    expect(aliases).toEqual([
      {
        shortName: "macs-configurator",
        workspaceRoot: "/tmp/configurator",
        jiraProjects: ["CFG"],
      },
      { shortName: "macs-scanner", workspaceRoot: "/tmp/scanner", jiraProjects: ["SA"] },
      { shortName: "skunkworks", workspaceRoot: "/tmp/skunkworks" },
    ]);
    expect(parseSimpleAliasesYaml("example-project: /tmp/example-project\n")).toEqual({
      "example-project": "/tmp/example-project",
    });
  });
});
