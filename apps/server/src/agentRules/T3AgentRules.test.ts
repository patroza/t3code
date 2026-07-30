import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  formatT3AgentRulesPointer,
  formatT3AgentRulesSessionPointer,
  resolveT3AgentRulesPath,
} from "./T3AgentRules.ts";

describe("resolveT3AgentRulesPath", () => {
  it("points at an existing markdown file", () => {
    const path = resolveT3AgentRulesPath();
    assert.ok(path.endsWith("t3-agent-rules.md"));
    assert.ok(existsSync(path), `rules file missing: ${path}`);
    assert.ok(readFileSync(path, "utf8").includes("always markdown hyperlinks"));
  });
});

describe("formatT3AgentRulesPointer", () => {
  it("formats a file pointer block without embedding the body", () => {
    const path = resolveT3AgentRulesPath();
    const block = formatT3AgentRulesPointer(path);
    assert.ok(block.includes(`rules: ${path}`));
    assert.equal(block.includes("always markdown hyperlinks"), false);
  });
});

describe("formatT3AgentRulesSessionPointer", () => {
  it("is a single-line path instruction", () => {
    const path = resolveT3AgentRulesPath();
    const line = formatT3AgentRulesSessionPointer(path);
    assert.ok(line.includes(path));
    assert.equal(line.includes("\n"), false);
  });
});
