import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  ensureCursorHarnessGlobalAgentRules,
  ensureGrokHarnessGlobalAgentRules,
  ensureHarnessGlobalAgentRules,
  ensureKimiHarnessGlobalAgentRules,
  ensureOpenCodeHarnessGlobalAgentRules,
  formatHarnessManagedRulesSection,
  HARNESS_RULES_BEGIN,
  HARNESS_RULES_END,
  HARNESS_RULES_LINK_NAME,
  upsertHarnessManagedRulesSection,
} from "./HarnessGlobalAgentRules.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-harness-rules-"));
  tempDirs.push(dir);
  return dir;
}

describe("upsertHarnessManagedRulesSection", () => {
  it("appends a managed section to existing user content", () => {
    const next = upsertHarnessManagedRulesSection(
      "# My prefs\n- use pnpm\n",
      "/home/x/t3-agent-rules.md",
    );
    NodeAssert.ok(next.startsWith("# My prefs"));
    NodeAssert.ok(next.includes(HARNESS_RULES_BEGIN));
    NodeAssert.ok(next.includes("`/home/x/t3-agent-rules.md`"));
  });

  it("replaces an existing managed section without losing user content", () => {
    const first = upsertHarnessManagedRulesSection("hello", "/old/path.md");
    const second = upsertHarnessManagedRulesSection(first, "/new/path.md");
    NodeAssert.equal(second.includes("/old/path.md"), false);
    NodeAssert.ok(second.includes("/new/path.md"));
    NodeAssert.ok(second.includes("hello"));
    NodeAssert.equal(second.split(HARNESS_RULES_BEGIN).length, 2);
  });
});

describe("ensureHarnessGlobalAgentRules", () => {
  it("symlinks t3-agent-rules.md and writes AGENTS.md managed section", () => {
    const home = makeTempDir();
    const product = NodePath.join(home, "product-rules.md");
    NodeFS.writeFileSync(product, "# product\n", "utf8");
    NodeFS.writeFileSync(NodePath.join(home, "AGENTS.md"), "# user global\n", "utf8");

    const result = ensureHarnessGlobalAgentRules({
      homeDir: home,
      instructionFileName: "AGENTS.md",
      productRulesPath: product,
    });

    NodeAssert.equal(result.linkStatus, "created");
    NodeAssert.equal(result.instructionUpdated, true);
    NodeAssert.ok(NodeFS.existsSync(result.rulesLinkPath));
    NodeAssert.equal(NodeFS.readlinkSync(result.rulesLinkPath), product);

    const agents = NodeFS.readFileSync(NodePath.join(home, "AGENTS.md"), "utf8");
    NodeAssert.ok(agents.includes("# user global"));
    NodeAssert.ok(agents.includes(HARNESS_RULES_BEGIN));
    NodeAssert.ok(agents.includes(HARNESS_RULES_END));
    NodeAssert.ok(agents.includes(HARNESS_RULES_LINK_NAME));

    const again = ensureHarnessGlobalAgentRules({
      homeDir: home,
      instructionFileName: "AGENTS.md",
      productRulesPath: product,
    });
    NodeAssert.equal(again.linkStatus, "ok");
    NodeAssert.equal(again.instructionUpdated, false);
  });

  it("writes CLAUDE.md for Claude config dirs", () => {
    const home = makeTempDir();
    const product = NodePath.join(home, "product.md");
    NodeFS.writeFileSync(product, "rules\n", "utf8");

    ensureHarnessGlobalAgentRules({
      homeDir: home,
      instructionFileName: "CLAUDE.md",
      productRulesPath: product,
    });

    NodeAssert.ok(NodeFS.existsSync(NodePath.join(home, "CLAUDE.md")));
    const body = NodeFS.readFileSync(NodePath.join(home, "CLAUDE.md"), "utf8");
    NodeAssert.ok(body.includes(HARNESS_RULES_BEGIN));
    NodeAssert.ok(
      body.includes(
        formatHarnessManagedRulesSection(NodePath.join(home, HARNESS_RULES_LINK_NAME)).slice(0, 40),
      ),
    );
  });

  it("does not clobber a real t3-agent-rules.md file", () => {
    const home = makeTempDir();
    NodeFS.mkdirSync(home, { recursive: true });
    const product = NodePath.join(home, "product.md");
    NodeFS.writeFileSync(product, "p\n", "utf8");
    const linkPath = NodePath.join(home, HARNESS_RULES_LINK_NAME);
    NodeFS.writeFileSync(linkPath, "user owned\n", "utf8");

    const result = ensureHarnessGlobalAgentRules({
      homeDir: home,
      instructionFileName: "AGENTS.md",
      productRulesPath: product,
    });
    NodeAssert.equal(result.linkStatus, "skipped");
    NodeAssert.equal(NodeFS.readFileSync(linkPath, "utf8"), "user owned\n");
  });
});

describe("per-harness install helpers", () => {
  it("installs into isolated homes via env overrides", () => {
    const root = makeTempDir();

    const grokHome = NodePath.join(root, "grok");
    const kimiHome = NodePath.join(root, "kimi");
    const openHome = NodePath.join(root, "opencode");
    const cursorHome = NodePath.join(root, "cursor");

    const env = {
      HOME: root,
      GROK_HOME: grokHome,
      KIMI_CODE_HOME: kimiHome,
      OPENCODE_CONFIG_DIR: openHome,
      OPENCODE_HOME: NodePath.join(root, "opencode-alt"),
      CURSOR_HOME: cursorHome,
    };

    NodeAssert.ok(ensureGrokHarnessGlobalAgentRules(env));
    NodeAssert.ok(NodeFS.existsSync(NodePath.join(grokHome, "AGENTS.md")));

    NodeAssert.ok(ensureKimiHarnessGlobalAgentRules(env));
    NodeAssert.ok(NodeFS.existsSync(NodePath.join(kimiHome, "AGENTS.md")));

    const openResults = ensureOpenCodeHarnessGlobalAgentRules(env);
    NodeAssert.ok(openResults.length >= 1);
    NodeAssert.ok(NodeFS.existsSync(NodePath.join(openHome, "AGENTS.md")));

    NodeAssert.ok(ensureCursorHarnessGlobalAgentRules(env));
    NodeAssert.ok(NodeFS.existsSync(NodePath.join(cursorHome, "AGENTS.md")));
  });
});
