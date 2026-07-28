// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  loadAlertProcessRulesFromFileSync,
  parseAlertProcessRulesDocument,
} from "./alertProcessRules.ts";

describe("parseAlertProcessRulesDocument", () => {
  it("parses structured rules with size and duration shorthands", () => {
    const rules = parseAlertProcessRulesDocument({
      rules: [
        {
          id: "jaeger-linux",
          match: "jaeger-linux",
          rss: "4gb",
          duration: "5m",
        },
      ],
    });

    expect(rules).toEqual([
      {
        id: "jaeger-linux",
        match: "jaeger-linux",
        rssMbThreshold: 4096,
        sustainedForMs: 5 * 60_000,
      },
    ]);
  });

  it("accepts cpu-only rules", () => {
    const rules = parseAlertProcessRulesDocument([
      {
        id: "cpu-hot",
        match: "worker",
        cpuPercentThreshold: 90,
        sustainedFor: "2m",
      },
    ]);

    expect(rules[0]).toEqual({
      id: "cpu-hot",
      match: "worker",
      cpuPercentThreshold: 90,
      sustainedForMs: 2 * 60_000,
    });
  });
});

describe("loadAlertProcessRulesFromFileSync", () => {
  it("loads yaml files", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bot-alert-rules-"));
    const yamlPath = NodePath.join(dir, "alert-rules.yaml");
    await NodeFSP.writeFile(
      yamlPath,
      [
        "rules:",
        "  - id: jaeger-linux",
        "    match: jaeger-linux",
        "    rss: 4gb",
        "    duration: 5m",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(loadAlertProcessRulesFromFileSync(yamlPath)).toEqual([
      {
        id: "jaeger-linux",
        match: "jaeger-linux",
        rssMbThreshold: 4096,
        sustainedForMs: 5 * 60_000,
      },
    ]);
  });
});
