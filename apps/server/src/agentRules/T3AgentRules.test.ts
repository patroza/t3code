import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  ensureT3AgentRulesInput,
  formatAgentRulesPointer,
  formatT3AgentRulesPointer,
  resolveT3AgentRulesPath,
  T3_AGENT_RULES_HEADER,
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

describe("formatAgentRulesPointer", () => {
  it("matches the Discord rules: path shape", () => {
    assert.equal(
      formatAgentRulesPointer("/tmp/rules.md", "## Discord conversation context"),
      `## Discord conversation context
rules: /tmp/rules.md`,
    );
  });
});

describe("withT3AgentRules", () => {
  it("returns undefined for undefined input", () => {
    assert.equal(withT3AgentRules(undefined), undefined);
  });

  it("prepends a rules file pointer, not the rules body", () => {
    const rulesPath = resolveT3AgentRulesPath();
    const result = withT3AgentRules("Fix the flaky test");
    assert.ok(result?.startsWith(T3_AGENT_RULES_HEADER));
    assert.ok(result?.includes(`rules: ${rulesPath}`));
    assert.ok(result?.includes("Fix the flaky test"));
    // Body stays in the file — do not paste hyperlink prose into the prompt.
    assert.equal(result?.includes("Jira API Markdown→ADF"), false);
    assert.equal(result?.includes("always markdown hyperlinks"), false);
  });

  it("is idempotent when the header is already present", () => {
    const once = withT3AgentRules("hello");
    assert.ok(once);
    const twice = withT3AgentRules(once);
    assert.equal(twice, once);
    assert.equal(twice?.split(T3_AGENT_RULES_HEADER).length, 2);
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
    assert.ok(result?.includes(T3_AGENT_RULES_HEADER));
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
