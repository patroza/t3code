import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { formatAgentRulesPointer } from "./agentRulesPointer.ts";

describe("formatAgentRulesPointer", () => {
  it("formats header + rules path like Discord turns", () => {
    assert.equal(
      formatAgentRulesPointer("/var/lib/t3/agent-turn-rules.md", "## Discord conversation context"),
      `## Discord conversation context
rules: /var/lib/t3/agent-turn-rules.md`,
    );
  });

  it("formats product-wide T3 agent context the same way", () => {
    assert.equal(
      formatAgentRulesPointer("/opt/t3/docs/t3-agent-rules.md", "## T3 agent context"),
      `## T3 agent context
rules: /opt/t3/docs/t3-agent-rules.md`,
    );
  });
});
