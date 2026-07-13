import type { ProviderInteractionMode } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

const GROK_PLAN_MODE_ALIASES = ["plan", "architect"] as const;
const GROK_DEFAULT_MODE_ALIASES = [
  "default",
  "code",
  "agent",
  "build",
  "normal",
  "ask",
  "implement",
  "chat",
] as const;

function normalizeModeId(modeId: string): string {
  return modeId.trim().toLowerCase();
}

/**
 * Maps a Grok/ACP session mode id onto T3's app-level interaction mode.
 * Returns undefined for unrelated mode ids (e.g. effort levels).
 */
export function interactionModeFromGrokAcpModeId(
  modeId: string,
): ProviderInteractionMode | undefined {
  const normalized = normalizeModeId(modeId);
  if (!normalized) {
    return undefined;
  }
  if ((GROK_PLAN_MODE_ALIASES as ReadonlyArray<string>).includes(normalized)) {
    return "plan";
  }
  if ((GROK_DEFAULT_MODE_ALIASES as ReadonlyArray<string>).includes(normalized)) {
    return "default";
  }
  return undefined;
}

export function resolveGrokAcpModeIdForInteractionMode(
  interactionMode: ProviderInteractionMode | undefined,
): string | undefined {
  if (interactionMode === "plan") {
    return "plan";
  }
  if (interactionMode === "default") {
    return "default";
  }
  return undefined;
}

function toolMetaName(params: EffectAcpSchema.RequestPermissionRequest): string | undefined {
  const meta = params.toolCall._meta;
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const xaiTool = (meta as Record<string, unknown>)["x.ai/tool"];
  if (!xaiTool || typeof xaiTool !== "object") {
    return undefined;
  }
  const name = (xaiTool as Record<string, unknown>).name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
}

function toolMetaKind(params: EffectAcpSchema.RequestPermissionRequest): string | undefined {
  const meta = params.toolCall._meta;
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const xaiTool = (meta as Record<string, unknown>)["x.ai/tool"];
  if (!xaiTool || typeof xaiTool !== "object") {
    return undefined;
  }
  const kind = (xaiTool as Record<string, unknown>).kind;
  return typeof kind === "string" && kind.trim().length > 0 ? kind.trim() : undefined;
}

/**
 * Detects Grok's exit_plan_mode / ExitPlanMode permission requests used to
 * present a plan for user approval.
 */
export function isGrokExitPlanModePermission(
  params: EffectAcpSchema.RequestPermissionRequest,
): boolean {
  const title = params.toolCall.title?.trim().toLowerCase() ?? "";
  const metaName = toolMetaName(params)?.toLowerCase() ?? "";
  const metaKind = toolMetaKind(params)?.toLowerCase() ?? "";
  const rawInput = params.toolCall.rawInput;
  const rawVariant =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? String((rawInput as Record<string, unknown>).variant ?? "")
          .trim()
          .toLowerCase()
      : "";

  return (
    metaName === "exit_plan_mode" ||
    metaKind === "exit_plan" ||
    title === "exit_plan_mode" ||
    title === "plan: exit" ||
    title.includes("exit plan") ||
    rawVariant === "exitplanmode"
  );
}

/**
 * Detects plan-file writes so we can capture plan markdown before exit_plan_mode.
 */
export function extractGrokPlanMarkdownFromToolWrite(
  toolCall: {
    readonly title?: string | null;
    readonly rawInput?: unknown;
    readonly _meta?: unknown;
  },
  options?: {
    readonly sessionId?: string;
  },
): string | undefined {
  const rawInput = toolCall.rawInput;
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return undefined;
  }
  const record = rawInput as Record<string, unknown>;
  const filePath =
    typeof record.file_path === "string"
      ? record.file_path
      : typeof record.path === "string"
        ? record.path
        : undefined;
  const content = typeof record.content === "string" ? record.content : undefined;
  if (!filePath || content === undefined) {
    return undefined;
  }
  const normalizedPath = filePath.replaceAll("\\", "/");
  const isPlanFile =
    normalizedPath.endsWith("/plan.md") ||
    normalizedPath.endsWith("plan.md") ||
    (options?.sessionId !== undefined && normalizedPath.includes(options.sessionId));
  if (!isPlanFile) {
    // Still accept when meta names the write as plan mode plan file via title.
    const title = toolCall.title?.toLowerCase() ?? "";
    if (!title.includes("plan.md")) {
      return undefined;
    }
  }
  const trimmed = content.trim();
  return trimmed.length > 0 ? content : undefined;
}

export function resolveGrokSessionPlanMarkdownPath(input: {
  readonly homeDir: string;
  readonly cwd: string;
  readonly sessionId: string;
}): string {
  // Grok encodes the cwd as a URL-encoded path segment under ~/.grok/sessions.
  const encodedCwd = encodeURIComponent(input.cwd);
  return `${input.homeDir.replace(/\/$/, "")}/.grok/sessions/${encodedCwd}/${input.sessionId}/plan.md`;
}
