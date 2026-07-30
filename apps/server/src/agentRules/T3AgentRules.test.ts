import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  AGENT_RULES_HEADER,
  ensureT3AgentRulesInput,
  formatT3AgentRulesPointer,
  resolveT3AgentRulesPath,
  withT3AgentRules,
} from "./T3AgentRules.ts";

describe("resolveT3AgentRulesPath", () => {
  it("points at an existing markdown file", () => {
    const path = resolveT3AgentRulesPath();
    assert.ok(path.endsWith("t3-agent-rules.md"));
    assert.ok(existsSync(path), `rules file missing: ${path}`);
    const body = readFileSync(path, "utf8");
    assert.ok(body.includes("always markdown hyperlinks"));
  });
});

describe("withT3AgentRules", () => {
  it("returns undefined for undefined input", () => {
    assert.equal(withT3AgentRules(undefined), undefined);
  });

  it("prepends a global rules file pointer, not the body", () => {
    const rulesPath = resolveT3AgentRulesPath();
    const result = withT3AgentRules("Fix the flaky test");
    assert.ok(result?.startsWith(AGENT_RULES_HEADER));
    assert.ok(result?.includes(`rules: ${rulesPath}`));
    assert.ok(result?.includes("Fix the flaky test"));
    assert.equal(result?.includes("Jira API Markdown→ADF"), false);
    assert.equal(result?.includes("always markdown hyperlinks"), false);
  });

  it("merges global path with an existing Discord overlay without duplicating", () => {
    const globalPath = resolveT3AgentRulesPath();
    const overlay = "/tmp/agent-turn-rules.md";
    const input = `## Agent rules
rules: ${globalPath}
rules: ${overlay}

## Discord conversation context
req: 1@user

## User request
hi`;
    const once = withT3AgentRules(input);
    const twice = withT3AgentRules(once);
    assert.equal(once, twice);
    assert.equal(once?.split(`rules: ${globalPath}`).length, 2);
    assert.ok(once?.includes(`rules: ${overlay}`));
  });

  it("adds global ahead of an overlay-only block", () => {
    const globalPath = resolveT3AgentRulesPath();
    const result = withT3AgentRules(`## Agent rules
rules: /tmp/overlay.md

## User request
x`);
    assert.ok(
      result?.startsWith(`## Agent rules
rules: ${globalPath}
rules: /tmp/overlay.md`),
    );
  });

  it("returns the pointer alone for empty text", () => {
    const pointer = formatT3AgentRulesPointer();
    assert.equal(withT3AgentRules(""), pointer);
    assert.equal(withT3AgentRules("   "), pointer);
  });
});

describe("ensureT3AgentRulesInput", () => {
  it("wraps normal text with a file pointer", () => {
    const result = ensureT3AgentRulesInput("do the thing", false);
    assert.ok(result?.includes("do the thing"));
    assert.ok(result?.includes(AGENT_RULES_HEADER));
    assert.ok(result?.includes("rules: "));
  });

  it("injects a pointer for attachment-only turns", () => {
    const result = ensureT3AgentRulesInput(undefined, true);
    assert.equal(result, formatT3AgentRulesPointer());
  });

  it("leaves fully empty turns alone", () => {
    assert.equal(ensureT3AgentRulesInput(undefined, false), undefined);
  });
});
