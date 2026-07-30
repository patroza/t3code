import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

import {
  AGENT_RULES_HEADER,
  dedupeAgentRulesPaths,
  ensureAgentRulesPaths,
  extractAgentRulesPaths,
  formatAgentRulesPointer,
  formatAgentRulesPointers,
  stripAgentRulesBlock,
} from "./agentRulesPointer.ts";

describe("formatAgentRulesPointers", () => {
  it("formats global + overlay under one header", () => {
    NodeAssert.equal(
      formatAgentRulesPointers([
        "/opt/t3/docs/t3-agent-rules.md",
        "/opt/t3/discord/agent-turn-rules.md",
      ]),
      `## Agent rules
rules: /opt/t3/docs/t3-agent-rules.md
rules: /opt/t3/discord/agent-turn-rules.md`,
    );
  });

  it("dedupes paths", () => {
    NodeAssert.equal(
      formatAgentRulesPointers(["/a.md", "/a.md", "/b.md"]),
      `## Agent rules
rules: /a.md
rules: /b.md`,
    );
  });

  it("returns empty for no paths", () => {
    NodeAssert.equal(formatAgentRulesPointers([]), "");
  });
});

describe("formatAgentRulesPointer", () => {
  it("still supports a custom single-path header", () => {
    NodeAssert.equal(
      formatAgentRulesPointer("/tmp/rules.md", "## Discord conversation context"),
      `## Discord conversation context
rules: /tmp/rules.md`,
    );
  });
});

describe("extract / strip / ensure", () => {
  const sample = `## Agent rules
rules: /global.md
rules: /discord.md

## Discord conversation context
req: 1@user
## User request
hello`;

  it("extracts rules paths from the agent-rules block", () => {
    NodeAssert.deepEqual(extractAgentRulesPaths(sample), ["/global.md", "/discord.md"]);
  });

  it("strips the agent-rules block", () => {
    const stripped = stripAgentRulesBlock(sample);
    NodeAssert.equal(stripped.includes(AGENT_RULES_HEADER), false);
    NodeAssert.equal(stripped.includes("## Discord conversation context"), true);
    NodeAssert.equal(stripped.includes("hello"), true);
  });

  it("merges required paths first and dedupes", () => {
    const merged = ensureAgentRulesPaths(sample, ["/global.md", "/extra.md"]);
    NodeAssert.equal(
      merged,
      `## Agent rules
rules: /global.md
rules: /extra.md
rules: /discord.md

## Discord conversation context
req: 1@user
## User request
hello`,
    );
  });

  it("adds a block when missing", () => {
    NodeAssert.equal(
      ensureAgentRulesPaths("just text", ["/global.md"]),
      `## Agent rules
rules: /global.md

just text`,
    );
  });

  it("dedupeAgentRulesPaths preserves order", () => {
    NodeAssert.deepEqual(dedupeAgentRulesPaths(["/b", "/a", "/b", ""]), ["/b", "/a"]);
  });
});
