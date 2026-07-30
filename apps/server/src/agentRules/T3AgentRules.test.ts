import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  ensureT3AgentRulesInput,
  formatT3AgentRulesSessionPointer,
  readT3AgentRulesInjected,
  resolveT3AgentRulesPath,
  T3_AGENT_RULES_INJECTED_KEY,
  withT3AgentRules,
} from "./T3AgentRules.ts";

describe("resolveT3AgentRulesPath", () => {
  it("points at an existing markdown file", () => {
    const path = resolveT3AgentRulesPath();
    assert.ok(path.endsWith("t3-agent-rules.md"));
    assert.ok(existsSync(path), `rules file missing: ${path}`);
    assert.ok(readFileSync(path, "utf8").includes("always markdown hyperlinks"));
  });
});

describe("session inject helpers", () => {
  it("prepends a file pointer, not the body", () => {
    const path = resolveT3AgentRulesPath();
    const result = withT3AgentRules("do the thing");
    assert.ok(result?.includes(`rules: ${path}`));
    assert.ok(result?.includes("do the thing"));
    assert.equal(result?.includes("always markdown hyperlinks"), false);
  });

  it("skips re-inject when already injected this session", () => {
    assert.equal(ensureT3AgentRulesInput("hello", false, true), "hello");
  });

  it("injects when session needs rules", () => {
    const result = ensureT3AgentRulesInput("hello", false, false);
    assert.ok(result?.includes("## Agent rules"));
    assert.ok(result?.includes("hello"));
  });

  it("reads the injected flag from runtime payload", () => {
    assert.equal(readT3AgentRulesInjected(null), false);
    assert.equal(readT3AgentRulesInjected({ [T3_AGENT_RULES_INJECTED_KEY]: true }), true);
    assert.equal(readT3AgentRulesInjected({ [T3_AGENT_RULES_INJECTED_KEY]: false }), false);
  });

  it("session pointer is a single line", () => {
    const line = formatT3AgentRulesSessionPointer(resolveT3AgentRulesPath());
    assert.equal(line.includes("\n"), false);
  });
});
