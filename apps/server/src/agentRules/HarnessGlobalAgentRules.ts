/**
 * Install T3 product rules into **harness-global** instruction files for every
 * provider we can identify a home directory for:
 *
 * | Harness  | Home                         | File        |
 * |----------|------------------------------|-------------|
 * | Codex    | `$CODEX_HOME`                | `AGENTS.md` |
 * | Claude   | `$CLAUDE_CONFIG_DIR`/`~/.claude` | `CLAUDE.md` |
 * | Grok     | `~/.grok`                    | `AGENTS.md` |
 * | Kimi     | `$KIMI_CODE_HOME` / `~/.kimi`| `AGENTS.md` |
 * | OpenCode | `~/.config/opencode` / `~/.opencode` | `AGENTS.md` |
 * | Cursor   | `~/.cursor`                  | `AGENTS.md` |
 *
 * These are loaded by the harness as user-level instructions — not chat turns —
 * so they survive conversation compaction. Not project AGENTS.md.
 *
 * Universal backup for all harnesses (including those without durable global
 * files): session inject + re-inject after compaction in ProviderService.
 *
 * Strategy:
 * 1. Symlink `<home>/t3-agent-rules.md` → product rules file
 * 2. Upsert a managed marker section into the harness instruction file
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
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
  if (NodeFS.existsSync(linkPath) || isSymlink(linkPath)) {
    try {
      const stat = NodeFS.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const current = NodeFS.readlinkSync(linkPath);
        const resolved = NodePath.resolve(NodePath.dirname(linkPath), current);
        if (resolved === absoluteTarget) {
          return "ok";
        }
        NodeFS.unlinkSync(linkPath);
      } else {
        return "skipped";
      }
    } catch {
      return "skipped";
    }
  }
  NodeFS.mkdirSync(NodePath.dirname(linkPath), { recursive: true });
  NodeFS.symlinkSync(absoluteTarget, linkPath);
  return "created";
}

function isSymlink(path: string): boolean {
  try {
    return NodeFS.lstatSync(path).isSymbolicLink();
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

  NodeFS.mkdirSync(homeDir, { recursive: true });
  const linkStatus = ensureSymlinkTo(productRulesPath, rulesLinkPath);

  const existing = NodeFS.existsSync(instructionFile)
    ? NodeFS.readFileSync(instructionFile, "utf8")
    : "";
  const next = upsertHarnessManagedRulesSection(existing, rulesLinkPath);
  const instructionUpdated = next !== existing;
  if (instructionUpdated) {
    NodeFS.writeFileSync(instructionFile, next, "utf8");
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

/** Best-effort install; never throws into provider startup. */
export function tryEnsureHarnessGlobalAgentRules(input: {
  readonly homeDir: string;
  readonly instructionFileName: HarnessInstructionFile;
  readonly productRulesPath?: string;
}): EnsureHarnessGlobalAgentRulesResult | null {
  try {
    return ensureHarnessGlobalAgentRules(input);
  } catch {
    return null;
  }
}

function homeFromEnv(
  env: NodeJS.ProcessEnv | undefined,
  key: string,
  fallbackRelative: string,
): string {
  const fromEnv = env?.[key]?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return NodePath.resolve(fromEnv.replace(/^~(?=\/|$)/u, NodeOS.homedir()));
  }
  return NodePath.resolve(NodeOS.homedir(), fallbackRelative);
}

/** Grok agent global home (`~/.grok`). */
export function ensureGrokHarnessGlobalAgentRules(
  env?: NodeJS.ProcessEnv,
): EnsureHarnessGlobalAgentRulesResult | null {
  return tryEnsureHarnessGlobalAgentRules({
    homeDir: homeFromEnv(env, "GROK_HOME", ".grok"),
    instructionFileName: "AGENTS.md",
  });
}

/** Kimi Code home (`$KIMI_CODE_HOME` or `~/.kimi`). */
export function ensureKimiHarnessGlobalAgentRules(
  env?: NodeJS.ProcessEnv,
): EnsureHarnessGlobalAgentRulesResult | null {
  const fromEnv = env?.KIMI_CODE_HOME?.trim();
  const homeDir =
    fromEnv && fromEnv.length > 0
      ? NodePath.resolve(fromEnv.replace(/^~(?=\/|$)/u, NodeOS.homedir()))
      : NodePath.resolve(NodeOS.homedir(), ".kimi");
  return tryEnsureHarnessGlobalAgentRules({
    homeDir,
    instructionFileName: "AGENTS.md",
  });
}

/** OpenCode config dirs (both common locations). */
export function ensureOpenCodeHarnessGlobalAgentRules(
  env?: NodeJS.ProcessEnv,
): ReadonlyArray<EnsureHarnessGlobalAgentRulesResult> {
  const homes = [
    homeFromEnv(env, "OPENCODE_CONFIG_DIR", ".config/opencode"),
    homeFromEnv(env, "OPENCODE_HOME", ".opencode"),
  ];
  const results: EnsureHarnessGlobalAgentRulesResult[] = [];
  for (const homeDir of homes) {
    const result = tryEnsureHarnessGlobalAgentRules({
      homeDir,
      instructionFileName: "AGENTS.md",
    });
    if (result) results.push(result);
  }
  return results;
}

/** Cursor agent home (`~/.cursor`). */
export function ensureCursorHarnessGlobalAgentRules(
  env?: NodeJS.ProcessEnv,
): EnsureHarnessGlobalAgentRulesResult | null {
  return tryEnsureHarnessGlobalAgentRules({
    homeDir: homeFromEnv(env, "CURSOR_HOME", ".cursor"),
    instructionFileName: "AGENTS.md",
  });
}
