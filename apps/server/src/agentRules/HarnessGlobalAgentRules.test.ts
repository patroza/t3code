import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  ensureHarnessGlobalAgentRules,
  formatHarnessManagedRulesSection,
  HARNESS_RULES_BEGIN,
  HARNESS_RULES_END,
  HARNESS_RULES_LINK_NAME,
  upsertHarnessManagedRulesSection,
} from "./HarnessGlobalAgentRules.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(NodePath.join(tmpdir(), "t3-harness-rules-"));
  tempDirs.push(dir);
  return dir;
}

describe("upsertHarnessManagedRulesSection", () => {
  it("appends a managed section to existing user content", () => {
    const next = upsertHarnessManagedRulesSection(
      "# My prefs\n- use pnpm\n",
      "/home/x/t3-agent-rules.md",
    );
    assert.ok(next.startsWith("# My prefs"));
    assert.ok(next.includes(HARNESS_RULES_BEGIN));
    assert.ok(next.includes("`/home/x/t3-agent-rules.md`"));
  });

  it("replaces an existing managed section without losing user content", () => {
    const first = upsertHarnessManagedRulesSection("hello", "/old/path.md");
    const second = upsertHarnessManagedRulesSection(first, "/new/path.md");
    assert.equal(second.includes("/old/path.md"), false);
    assert.ok(second.includes("/new/path.md"));
    assert.ok(second.includes("hello"));
    assert.equal(second.split(HARNESS_RULES_BEGIN).length, 2);
  });
});

describe("ensureHarnessGlobalAgentRules", () => {
  it("symlinks t3-agent-rules.md and writes AGENTS.md managed section", () => {
    const home = makeTempDir();
    const product = NodePath.join(home, "product-rules.md");
    writeFileSync(product, "# product\n", "utf8");
    writeFileSync(NodePath.join(home, "AGENTS.md"), "# user global\n", "utf8");

    const result = ensureHarnessGlobalAgentRules({
      homeDir: home,
      instructionFileName: "AGENTS.md",
      productRulesPath: product,
    });

    assert.equal(result.linkStatus, "created");
    assert.equal(result.instructionUpdated, true);
    assert.ok(existsSync(result.rulesLinkPath));
    assert.equal(readlinkSync(result.rulesLinkPath), product);

    const agents = readFileSync(NodePath.join(home, "AGENTS.md"), "utf8");
    assert.ok(agents.includes("# user global"));
    assert.ok(agents.includes(HARNESS_RULES_BEGIN));
    assert.ok(agents.includes(HARNESS_RULES_END));
    assert.ok(agents.includes(HARNESS_RULES_LINK_NAME));

    const again = ensureHarnessGlobalAgentRules({
      homeDir: home,
      instructionFileName: "AGENTS.md",
      productRulesPath: product,
    });
    assert.equal(again.linkStatus, "ok");
    assert.equal(again.instructionUpdated, false);
  });

  it("writes CLAUDE.md for Claude config dirs", () => {
    const home = makeTempDir();
    const product = NodePath.join(home, "product.md");
    writeFileSync(product, "rules\n", "utf8");

    ensureHarnessGlobalAgentRules({
      homeDir: home,
      instructionFileName: "CLAUDE.md",
      productRulesPath: product,
    });

    assert.ok(existsSync(NodePath.join(home, "CLAUDE.md")));
    const body = readFileSync(NodePath.join(home, "CLAUDE.md"), "utf8");
    assert.ok(body.includes(HARNESS_RULES_BEGIN));
    assert.ok(
      body.includes(
        formatHarnessManagedRulesSection(NodePath.join(home, HARNESS_RULES_LINK_NAME)).slice(0, 40),
      ),
    );
  });

  it("does not clobber a real t3-agent-rules.md file", () => {
    const home = makeTempDir();
    mkdirSync(home, { recursive: true });
    const product = NodePath.join(home, "product.md");
    writeFileSync(product, "p\n", "utf8");
    const linkPath = NodePath.join(home, HARNESS_RULES_LINK_NAME);
    writeFileSync(linkPath, "user owned\n", "utf8");

    const result = ensureHarnessGlobalAgentRules({
      homeDir: home,
      instructionFileName: "AGENTS.md",
      productRulesPath: product,
    });
    assert.equal(result.linkStatus, "skipped");
    assert.equal(readFileSync(linkPath, "utf8"), "user owned\n");
  });
});
