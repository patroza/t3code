/**
 * Install T3 product rules into **harness-global** instruction files
 * (Codex `$CODEX_HOME/AGENTS.md`, Claude `$CLAUDE_CONFIG_DIR/CLAUDE.md`).
 *
 * These are loaded by the provider harness as user-level instructions — not as
 * chat turns — so they survive conversation compaction. This is intentionally
 * **not** project AGENTS.md / CLAUDE.md (repo-local conventions stay separate).
 *
 * Strategy:
 * 1. Symlink `<home>/t3-agent-rules.md` → product rules file
 * 2. Upsert a managed marker section into the harness instruction file that
 *    tells the agent to read that symlink (preserves the rest of the user's
 *    global AGENTS.md / CLAUDE.md)
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as NodePath from "node:path";

import { resolveT3AgentRulesPath } from "./T3AgentRules.ts";

export const HARNESS_RULES_LINK_NAME = "t3-agent-rules.md";
export const HARNESS_RULES_BEGIN = "<!-- t3-code-agent-rules:begin -->";
export const HARNESS_RULES_END = "<!-- t3-code-agent-rules:end -->";

export type HarnessInstructionFile = "AGENTS.md" | "CLAUDE.md";

export function formatHarnessManagedRulesSection(rulesLinkPath: string): string {
  return `${HARNESS_RULES_BEGIN}
# T3 Code product rules (harness-global)

Always read and follow: \`${rulesLinkPath}\`

These apply to every T3 Code session for this harness home. Project \`AGENTS.md\` /
\`CLAUDE.md\` still own **repo-local** conventions. Client overlays (e.g. Discord)
are separate surface files when present.
${HARNESS_RULES_END}`;
}

/** Insert or replace the managed T3 section; preserve the rest of the file. */
export function upsertHarnessManagedRulesSection(existing: string, rulesLinkPath: string): string {
  const section = formatHarnessManagedRulesSection(rulesLinkPath);
  if (existing.includes(HARNESS_RULES_BEGIN) && existing.includes(HARNESS_RULES_END)) {
    return existing.replace(
      new RegExp(
        `${escapeRegExp(HARNESS_RULES_BEGIN)}[\\s\\S]*?${escapeRegExp(HARNESS_RULES_END)}`,
        "u",
      ),
      section,
    );
  }
  const trimmed = existing.trimEnd();
  if (trimmed.length === 0) {
    return `${section}\n`;
  }
  return `${trimmed}\n\n${section}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Ensure `linkPath` is a symlink to `targetPath` (absolute).
 * Replaces a wrong symlink; refuses to clobber a regular file.
 */
export function ensureSymlinkTo(
  targetPath: string,
  linkPath: string,
): "created" | "ok" | "skipped" {
  const absoluteTarget = NodePath.resolve(targetPath);
  if (existsSync(linkPath) || isSymlink(linkPath)) {
    try {
      const stat = lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const current = readlinkSync(linkPath);
        const resolved = NodePath.resolve(NodePath.dirname(linkPath), current);
        if (resolved === absoluteTarget) {
          return "ok";
        }
        unlinkSync(linkPath);
      } else {
        return "skipped";
      }
    } catch {
      return "skipped";
    }
  }
  mkdirSync(NodePath.dirname(linkPath), { recursive: true });
  symlinkSync(absoluteTarget, linkPath);
  return "created";
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface EnsureHarnessGlobalAgentRulesResult {
  readonly homeDir: string;
  readonly instructionFile: string;
  readonly rulesLinkPath: string;
  readonly productRulesPath: string;
  readonly linkStatus: "created" | "ok" | "skipped";
  readonly instructionUpdated: boolean;
}

/**
 * Install product rules into a harness home directory.
 * `homeDir` is CODEX_HOME or CLAUDE_CONFIG_DIR (not the project cwd).
 */
export function ensureHarnessGlobalAgentRules(input: {
  readonly homeDir: string;
  readonly instructionFileName: HarnessInstructionFile;
  readonly productRulesPath?: string;
}): EnsureHarnessGlobalAgentRulesResult {
  const homeDir = NodePath.resolve(input.homeDir);
  const productRulesPath = input.productRulesPath ?? resolveT3AgentRulesPath();
  const rulesLinkPath = NodePath.join(homeDir, HARNESS_RULES_LINK_NAME);
  const instructionFile = NodePath.join(homeDir, input.instructionFileName);

  mkdirSync(homeDir, { recursive: true });
  const linkStatus = ensureSymlinkTo(productRulesPath, rulesLinkPath);

  const existing = existsSync(instructionFile) ? readFileSync(instructionFile, "utf8") : "";
  const next = upsertHarnessManagedRulesSection(existing, rulesLinkPath);
  const instructionUpdated = next !== existing;
  if (instructionUpdated) {
    writeFileSync(instructionFile, next, "utf8");
  }

  return {
    homeDir,
    instructionFile,
    rulesLinkPath,
    productRulesPath,
    linkStatus,
    instructionUpdated,
  };
}
