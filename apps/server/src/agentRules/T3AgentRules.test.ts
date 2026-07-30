import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import { describe, it } from "vitest";

import {
  ensureT3AgentRulesInput,
  readT3AgentRulesInjected,
  resolveT3AgentRulesPath,
  T3_AGENT_RULES_INJECTED_KEY,
  withT3AgentRules,
} from "./T3AgentRules.ts";

describe("resolveT3AgentRulesPath", () => {
  it("points at an existing markdown file", () => {
    const path = resolveT3AgentRulesPath();
    NodeAssert.ok(path.endsWith("t3-agent-rules.md"));
    NodeAssert.ok(NodeFS.existsSync(path), `rules file missing: ${path}`);
    NodeAssert.ok(NodeFS.readFileSync(path, "utf8").includes("always markdown hyperlinks"));
  });
});

describe("session inject helpers", () => {
  it("prepends a file pointer, not the body", () => {
    const path = resolveT3AgentRulesPath();
    const result = withT3AgentRules("do the thing");
    NodeAssert.ok(result?.includes(`rules: ${path}`));
    NodeAssert.ok(result?.includes("do the thing"));
    NodeAssert.equal(result?.includes("always markdown hyperlinks"), false);
  });

  it("skips re-inject when already injected this session", () => {
    NodeAssert.equal(ensureT3AgentRulesInput("hello", false, true), "hello");
  });

  it("injects when session needs rules", () => {
    const result = ensureT3AgentRulesInput("hello", false, false);
    NodeAssert.ok(result?.includes("## Agent rules"));
    NodeAssert.ok(result?.includes("hello"));
  });

  it("reads the injected flag from runtime payload", () => {
    NodeAssert.equal(readT3AgentRulesInjected(null), false);
    NodeAssert.equal(readT3AgentRulesInjected({ [T3_AGENT_RULES_INJECTED_KEY]: true }), true);
    NodeAssert.equal(readT3AgentRulesInjected({ [T3_AGENT_RULES_INJECTED_KEY]: false }), false);
  });
});
