import {
  MAX_SCRIPT_ID_LENGTH,
  SCRIPT_RUN_COMMAND_PATTERN,
  type KeybindingCommand,
  type ProjectScript,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

export interface ProjectScriptInput {
  readonly name: ProjectScript["name"];
  readonly command: ProjectScript["command"];
  readonly icon: ProjectScript["icon"];
  readonly runOnWorktreeCreate: ProjectScript["runOnWorktreeCreate"];
  readonly runOnWorktreeRemove: boolean;
  readonly runOnPrMerged: boolean;
  readonly previewUrl: Exclude<ProjectScript["previewUrl"], undefined> | null;
  readonly autoOpenPreview: boolean;
}

export function buildProjectScript(id: string, input: ProjectScriptInput): ProjectScript {
  return {
    id,
    name: input.name,
    command: input.command,
    icon: input.icon,
    runOnWorktreeCreate: input.runOnWorktreeCreate,
    ...(input.runOnWorktreeRemove ? { runOnWorktreeRemove: true } : {}),
    ...(input.runOnPrMerged ? { runOnPrMerged: true } : {}),
    ...(input.previewUrl === null
      ? {}
      : {
          previewUrl: input.previewUrl,
          autoOpenPreview: input.autoOpenPreview,
        }),
  };
}

function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    return "script";
  }
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

export const commandForProjectScript = (scriptId: string): KeybindingCommand =>
  SCRIPT_RUN_COMMAND_PATTERN.make(`script.${scriptId}.run`);

export function projectScriptIdFromCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!isScriptRunCommand(trimmed)) {
    return null;
  }
  const [prefix, , suffix] = SCRIPT_RUN_COMMAND_PATTERN.parts;
  return trimmed.slice(prefix.literal.length, -suffix.literal.length);
}

export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;

  let suffix = 2;
  while (suffix < 10_000) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
    suffix += 1;
  }

  // This last-resort fallback only triggers after exhausting thousands of suffixes.
  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

export function isLifecycleProjectScript(script: ProjectScript): boolean {
  return (
    script.runOnWorktreeCreate ||
    script.runOnWorktreeRemove === true ||
    script.runOnPrMerged === true
  );
}

export function projectScriptMenuLabel(script: ProjectScript): string {
  const tags: string[] = [];
  if (script.runOnWorktreeCreate) tags.push("setup");
  if (script.runOnWorktreeRemove === true) tags.push("teardown");
  if (script.runOnPrMerged === true) tags.push("pr-merged");
  return tags.length > 0 ? `${script.name} (${tags.join(", ")})` : script.name;
}

/**
 * At most one script may own each lifecycle hook. When `input` claims a hook,
 * strip that flag from other scripts so only the latest owner remains.
 */
export function clearConflictingLifecycleFlags(
  script: ProjectScript,
  input: Pick<ProjectScriptInput, "runOnWorktreeCreate" | "runOnWorktreeRemove" | "runOnPrMerged">,
): ProjectScript {
  let next = script;
  if (input.runOnWorktreeCreate && next.runOnWorktreeCreate) {
    next = { ...next, runOnWorktreeCreate: false };
  }
  if (input.runOnWorktreeRemove && next.runOnWorktreeRemove === true) {
    const { runOnWorktreeRemove: _removed, ...rest } = next;
    next = rest;
  }
  if (input.runOnPrMerged && next.runOnPrMerged === true) {
    const { runOnPrMerged: _removed, ...rest } = next;
    next = rest;
  }
  return next;
}

export function primaryProjectScript(scripts: ReadonlyArray<ProjectScript>): ProjectScript | null {
  const regular = scripts.find((script) => !isLifecycleProjectScript(script));
  return regular ?? scripts[0] ?? null;
}
