// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

type Provider = "codex" | "claudeAgent" | "opencode";
export type ImportSessionsProvider = "all" | "codex" | "claude" | "opencode";
export type ImportSessionStatus = "imported" | "exists" | "dry-run";

interface ExternalSession {
  readonly provider: Provider;
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly model: string;
  readonly branch: string | null;
  readonly firstMessage: string | null;
  readonly resumeCursor: unknown;
  readonly modelOptions?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
}

export interface ImportSessionsOptions {
  readonly provider: ImportSessionsProvider;
  readonly cwd?: string;
  readonly limit: number;
  readonly dryRun: boolean;
  readonly baseDir?: string;
  readonly opencodeModel: string;
  readonly sessionId?: string;
}

export interface ImportSessionsResult {
  readonly provider: Provider;
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly status: ImportSessionStatus;
}

function homePath(value: string): string {
  return value === "~" || value.startsWith("~/")
    ? NodePath.join(NodeOS.homedir(), value.slice(value === "~" ? 1 : 2))
    : value;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function shortTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed || "Imported session";
}

function stableUuid(kind: string, key: string): string {
  const bytes = NodeCrypto.createHash("sha256").update(`${kind}:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sql(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqliteJson(dbPath: string, query: string): Array<Record<string, unknown>> {
  if (!NodeFS.existsSync(dbPath)) {
    return [];
  }
  const out = NodeChildProcess.execFileSync("sqlite3", ["-json", dbPath, query], {
    encoding: "utf8",
  }).trim();
  return out.length === 0 ? [] : (JSON.parse(out) as Array<Record<string, unknown>>);
}

function sqliteExec(dbPath: string, script: string): void {
  NodeChildProcess.execFileSync("sqlite3", [dbPath], { input: script });
}

function normalizeCwd(value: string | undefined): string | undefined {
  return value ? NodeFS.realpathSync.native(homePath(value)) : undefined;
}

function providersFor(value: ImportSessionsProvider): ReadonlyArray<Provider> {
  switch (value) {
    case "codex":
      return ["codex"];
    case "claude":
      return ["claudeAgent"];
    case "opencode":
      return ["opencode"];
    case "all":
      return ["codex", "claudeAgent", "opencode"];
  }
}

function readCodexSessions(input: {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly limit: number;
}): ReadonlyArray<ExternalSession> {
  const dbPath = NodePath.join(NodeOS.homedir(), ".codex", "state_5.sqlite");
  const where = [
    "archived = 0",
    input.sessionId ? `id = ${sql(input.sessionId)}` : undefined,
    input.cwd ? `cwd = ${sql(input.cwd)}` : undefined,
  ]
    .filter(Boolean)
    .join(" AND ");
  return sqliteJson(
    dbPath,
    `SELECT id,title,preview,first_user_message,cwd,created_at_ms,updated_at_ms,model,reasoning_effort,git_branch FROM threads WHERE ${where} ORDER BY updated_at_ms DESC LIMIT ${Number(input.limit)}`,
  ).map((row) => ({
    provider: "codex",
    id: String(row.id),
    title: shortTitle(String(row.title ?? row.preview ?? row.first_user_message ?? row.id)),
    cwd: String(row.cwd),
    createdAtMs: Number(row.created_at_ms ?? Date.now()),
    updatedAtMs: Number(row.updated_at_ms ?? row.created_at_ms ?? Date.now()),
    model: String(row.model ?? "gpt-5.5"),
    branch: typeof row.git_branch === "string" && row.git_branch.length > 0 ? row.git_branch : null,
    firstMessage:
      typeof row.first_user_message === "string" && row.first_user_message.length > 0
        ? row.first_user_message
        : null,
    resumeCursor: { threadId: String(row.id) },
    ...(typeof row.reasoning_effort === "string" && row.reasoning_effort.length > 0
      ? { modelOptions: [{ id: "reasoningEffort", value: row.reasoning_effort }] }
      : {}),
  }));
}

function readClaudeSessions(input: {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly limit: number;
}): ReadonlyArray<ExternalSession> {
  const root = NodePath.join(NodeOS.homedir(), ".claude", "projects");
  if (!NodeFS.existsSync(root)) {
    return [];
  }
  const files = NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => NodePath.join(entry.parentPath, entry.name));
  const sessions = files.flatMap((file): ReadonlyArray<ExternalSession> => {
    const id = NodePath.basename(file, ".jsonl");
    if (input.sessionId && id !== input.sessionId) {
      return [];
    }
    const lines = NodeFS.readFileSync(file, "utf8").split("\n").filter(Boolean);
    let cwd = "";
    let createdAtMs = Number.POSITIVE_INFINITY;
    let updatedAtMs = 0;
    let firstMessage: string | null = null;
    let lastAssistantUuid: string | undefined;
    let model = "claude-fable-5";
    for (const line of lines) {
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof row.cwd === "string" && row.cwd.length > 0) {
        cwd = row.cwd;
      }
      if (typeof row.timestamp === "string") {
        const time = Date.parse(row.timestamp);
        if (Number.isFinite(time)) {
          createdAtMs = Math.min(createdAtMs, time);
          updatedAtMs = Math.max(updatedAtMs, time);
        }
      }
      if (typeof row.model === "string") {
        model = row.model;
      }
      if (typeof row.uuid === "string" && row.type === "assistant") {
        lastAssistantUuid = row.uuid;
      }
      if (!firstMessage && row.type === "user" && row.message && typeof row.message === "object") {
        const content = (row.message as { readonly content?: unknown }).content;
        if (Array.isArray(content)) {
          const text = content
            .flatMap((part) =>
              part && typeof part === "object" && "text" in part && typeof part.text === "string"
                ? [part.text]
                : [],
            )
            .join("\n")
            .trim();
          firstMessage = text || null;
        }
      }
    }
    if (!cwd || (input.cwd && cwd !== input.cwd)) {
      return [];
    }
    return [
      {
        provider: "claudeAgent",
        id,
        title: shortTitle(firstMessage ?? id),
        cwd,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : updatedAtMs || Date.now(),
        updatedAtMs: updatedAtMs || Date.now(),
        model,
        branch: null,
        firstMessage,
        resumeCursor: {
          resume: id,
          ...(lastAssistantUuid ? { resumeSessionAt: lastAssistantUuid } : {}),
        },
      },
    ];
  });
  return sessions.sort((left, right) => right.updatedAtMs - left.updatedAtMs).slice(0, input.limit);
}

function readOpenCodeSessions(input: {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly limit: number;
  readonly model: string;
}): ReadonlyArray<ExternalSession> {
  const out = NodeChildProcess.execFileSync(
    "opencode",
    ["session", "list", "--format", "json", "-n", String(input.limit)],
    { cwd: input.cwd ?? process.cwd(), encoding: "utf8" },
  ).trim();
  if (out.length === 0) {
    return [];
  }
  return (JSON.parse(out) as Array<Record<string, unknown>>)
    .filter((row) => !input.sessionId || row.id === input.sessionId)
    .filter((row) => !input.cwd || row.directory === input.cwd)
    .map((row) => ({
      provider: "opencode",
      id: String(row.id),
      title: shortTitle(String(row.title ?? row.id)),
      cwd: String(row.directory),
      createdAtMs: Number(row.created ?? Date.now()),
      updatedAtMs: Number(row.updated ?? row.created ?? Date.now()),
      model: input.model,
      branch: null,
      firstMessage: null,
      resumeCursor: { sessionId: String(row.id) },
      modelOptions: [{ id: "agent", value: "build" }],
    }));
}

function findProject(input: {
  readonly dbPath: string;
  readonly baseDir: string;
  readonly cwd: string;
}): {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
} {
  const worktreesRoot = NodePath.join(input.baseDir, "worktrees");
  const relativeWorktree = input.cwd.startsWith(`${worktreesRoot}${NodePath.sep}`)
    ? NodePath.relative(worktreesRoot, input.cwd)
    : null;
  if (relativeWorktree) {
    const repoName = relativeWorktree.split(NodePath.sep)[0];
    const byTitle = sqliteJson(
      input.dbPath,
      `SELECT project_id,workspace_root FROM projection_projects WHERE deleted_at IS NULL AND title = ${sql(repoName)} LIMIT 1`,
    )[0];
    if (byTitle) {
      return {
        projectId: String(byTitle.project_id),
        workspaceRoot: String(byTitle.workspace_root),
        worktreePath: input.cwd,
      };
    }
  }
  const byRoot = sqliteJson(
    input.dbPath,
    `SELECT project_id,workspace_root FROM projection_projects WHERE deleted_at IS NULL AND workspace_root = ${sql(input.cwd)} LIMIT 1`,
  )[0];
  if (byRoot) {
    return { projectId: String(byRoot.project_id), workspaceRoot: input.cwd, worktreePath: null };
  }
  return {
    projectId: stableUuid("t3-project", input.cwd),
    workspaceRoot: input.cwd,
    worktreePath: null,
  };
}

function importSession(
  dbPath: string,
  baseDir: string,
  session: ExternalSession,
): "imported" | "exists" {
  const threadId = stableUuid(`t3-import-${session.provider}`, session.id);
  const exists = sqliteJson(
    dbPath,
    `SELECT thread_id FROM provider_session_runtime WHERE thread_id = ${sql(threadId)} LIMIT 1`,
  )[0];
  if (exists) {
    return "exists";
  }
  const createdAt = iso(session.createdAtMs);
  const updatedAt = iso(session.updatedAtMs);
  const project = findProject({ dbPath, baseDir, cwd: session.cwd });
  const projectTitle = NodePath.basename(project.workspaceRoot) || project.workspaceRoot;
  const modelSelection = {
    instanceId: session.provider,
    model: session.model,
    ...(session.modelOptions ? { options: session.modelOptions } : {}),
  };
  const messageId = stableUuid("t3-import-message", `${session.provider}:${session.id}`);
  const runtimePayload = {
    cwd: session.cwd,
    model: session.model,
    activeTurnId: null,
    lastError: null,
    modelSelection,
    lastRuntimeEvent: "imported.external.session",
    lastRuntimeEventAt: updatedAt,
  };
  const sessionPayload = {
    threadId,
    status: "stopped",
    providerName: session.provider,
    providerInstanceId: session.provider,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt,
  };
  const threadCreated = {
    threadId,
    projectId: project.projectId,
    title: session.title,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: session.branch,
    worktreePath: project.worktreePath,
    createdAt,
    updatedAt,
  };
  const script = `
BEGIN;
INSERT OR IGNORE INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at,default_model_selection_json)
VALUES (${sql(project.projectId)},${sql(projectTitle)},${sql(project.workspaceRoot)},'[]',${sql(createdAt)},${sql(createdAt)},NULL,${sql(JSON.stringify(modelSelection))});
INSERT INTO projection_threads (thread_id,project_id,title,branch,worktree_path,latest_turn_id,created_at,updated_at,deleted_at,runtime_mode,interaction_mode,model_selection_json,archived_at,latest_user_message_at,pending_approval_count,pending_user_input_count,has_actionable_proposed_plan)
VALUES (${sql(threadId)},${sql(project.projectId)},${sql(session.title)},${sql(session.branch)},${sql(project.worktreePath)},NULL,${sql(createdAt)},${sql(updatedAt)},NULL,'full-access','default',${sql(JSON.stringify(modelSelection))},NULL,${sql(createdAt)},0,0,0);
INSERT INTO projection_thread_sessions (thread_id,status,provider_name,provider_session_id,provider_thread_id,active_turn_id,last_error,updated_at,runtime_mode,provider_instance_id)
VALUES (${sql(threadId)},'stopped',${sql(session.provider)},NULL,NULL,NULL,NULL,${sql(updatedAt)},'full-access',${sql(session.provider)});
INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json,runtime_payload_json)
VALUES (${sql(threadId)},${sql(session.provider)},${sql(session.provider)},${sql(session.provider)},'full-access','stopped',${sql(updatedAt)},${sql(JSON.stringify(session.resumeCursor))},${sql(JSON.stringify(runtimePayload))});
${session.firstMessage ? `INSERT INTO projection_thread_messages (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at,attachments_json) VALUES (${sql(messageId)},${sql(threadId)},NULL,'user',${sql(session.firstMessage)},0,${sql(createdAt)},${sql(createdAt)},'[]');` : ""}
INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json)
VALUES (${sql(stableUuid("event-created", threadId))},'thread',${sql(threadId)},0,'thread.created',${sql(createdAt)},NULL,NULL,NULL,'system',${sql(JSON.stringify(threadCreated))},'{}');
INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json)
VALUES (${sql(stableUuid("event-session", threadId))},'thread',${sql(threadId)},1,'thread.session-set',${sql(updatedAt)},NULL,NULL,NULL,'system',${sql(JSON.stringify({ threadId, session: sessionPayload }))},'{}');
COMMIT;
`;
  sqliteExec(dbPath, script);
  return "imported";
}

export function runImportSessions(
  options: ImportSessionsOptions,
): ReadonlyArray<ImportSessionsResult> {
  const baseDir = homePath(options.baseDir ?? process.env.T3CODE_HOME ?? "~/.t3");
  const dbPath = NodePath.join(baseDir, "userdata", "state.sqlite");
  const cwd = normalizeCwd(options.cwd);
  const scanInput = {
    limit: options.limit,
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
  const sessions = providersFor(options.provider).flatMap((provider) => {
    switch (provider) {
      case "codex":
        return readCodexSessions(scanInput);
      case "claudeAgent":
        return readClaudeSessions(scanInput);
      case "opencode":
        return readOpenCodeSessions({
          ...scanInput,
          model: options.opencodeModel,
        });
    }
  });
  return sessions.map((session) => ({
    provider: session.provider,
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    status: options.dryRun ? "dry-run" : importSession(dbPath, baseDir, session),
  }));
}

export function formatImportSessionsResults(
  results: ReadonlyArray<ImportSessionsResult>,
  options: { readonly json: boolean },
): string {
  if (options.json) {
    return JSON.stringify(results, null, 2);
  }
  return results
    .map((result) => `${result.status}\t${result.provider}\t${result.id}\t${result.title}`)
    .join("\n");
}
