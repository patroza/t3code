import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  ensureT3AgentRulesInput,
  T3_AGENT_RULES_BLOCK,
  T3_AGENT_RULES_MARKER,
  withT3AgentRules,
} from "./T3AgentRules.ts";

describe("withT3AgentRules", () => {
  it("returns undefined for undefined input", () => {
    assert.equal(withT3AgentRules(undefined), undefined);
  });

  it("prepends the global rules block once", () => {
    const result = withT3AgentRules("Fix the flaky test");
    assert.ok(result?.startsWith(T3_AGENT_RULES_BLOCK));
    assert.ok(result?.includes("Fix the flaky test"));
    assert.ok(result?.includes("always markdown hyperlinks"));
  });

  it("is idempotent when the marker is already present", () => {
    const once = withT3AgentRules("hello");
    assert.ok(once);
    const twice = withT3AgentRules(once);
    assert.equal(twice, once);
    assert.equal(twice?.split(T3_AGENT_RULES_MARKER).length, 2);
  });

  it("returns rules alone for empty text", () => {
    assert.equal(withT3AgentRules(""), T3_AGENT_RULES_BLOCK);
    assert.equal(withT3AgentRules("   "), T3_AGENT_RULES_BLOCK);
  });
});

describe("ensureT3AgentRulesInput", () => {
  it("wraps normal text", () => {
    const result = ensureT3AgentRulesInput("do the thing", false);
    assert.ok(result?.includes("do the thing"));
    assert.ok(result?.includes(T3_AGENT_RULES_MARKER));
  });

  it("injects rules for attachment-only turns", () => {
    const result = ensureT3AgentRulesInput(undefined, true);
    assert.equal(result, T3_AGENT_RULES_BLOCK);
  });

  it("leaves fully empty turns alone", () => {
    assert.equal(ensureT3AgentRulesInput(undefined, false), undefined);
  });
});
