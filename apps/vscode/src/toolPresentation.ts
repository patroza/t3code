import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface PresentedToolCall {
  readonly id: string;
  readonly createdAt: string;
  readonly title: string;
  readonly itemType: string | null;
  readonly status: "running" | "completed" | "failed" | "stopped";
  readonly preview: string | null;
  readonly detail: string | null;
  readonly changedFiles: ReadonlyArray<string>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function commandText(value: unknown): string | null {
  if (typeof value === "string") return text(value);
  if (!Array.isArray(value)) return null;
  const parts = value.filter((part): part is string => typeof part === "string");
  return parts.length === value.length && parts.length > 0 ? parts.join(" ") : null;
}

function toolCallId(payload: Record<string, unknown>): string | null {
  return text(record(payload.data)?.toolCallId) ?? text(payload.toolCallId);
}

function toolCommand(payload: Record<string, unknown>): string | null {
  const data = record(payload.data);
  const item = record(data?.item);
  const input = record(item?.input);
  const result = record(item?.result);
  return (
    commandText(item?.command) ??
    commandText(input?.command) ??
    commandText(result?.command) ??
    commandText(data?.command)
  );
}

function rawOutputDetail(payload: Record<string, unknown>): string | null {
  const rawOutput = record(record(payload.data)?.rawOutput);
  if (rawOutput === null) return null;
  const totalFiles = typeof rawOutput.totalFiles === "number" ? rawOutput.totalFiles : null;
  if (totalFiles !== null) {
    return `${totalFiles} file${totalFiles === 1 ? "" : "s"}${rawOutput.truncated === true ? "+" : ""}`;
  }
  return text(rawOutput.content) ?? text(rawOutput.stdout);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth = 0): void {
  if (depth > 4 || target.length >= 12) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectChangedFiles(entry, target, seen, depth + 1);
    return;
  }
  const data = record(value);
  if (data === null) return;
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const path = text(data[key]);
    if (path !== null && !seen.has(path)) {
      seen.add(path);
      target.push(path);
    }
  }
  for (const key of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (key in data) collectChangedFiles(data[key], target, seen, depth + 1);
  }
}

function changedFiles(payload: Record<string, unknown>): ReadonlyArray<string> {
  const files: string[] = [];
  collectChangedFiles(payload.data, files, new Set());
  return files;
}

function expandedDetail(payload: Record<string, unknown>, command: string | null): string | null {
  const data = record(payload.data);
  const item = record(data?.item);
  const blocks = [command, text(payload.detail), rawOutputDetail(payload)];
  if (text(payload.itemType) === "mcp_tool_call" && item !== null) {
    blocks.push(JSON.stringify(item, null, 2));
  }
  const unique = [...new Set(blocks.filter((block): block is string => block !== null))];
  return unique.length > 0 ? unique.join("\n\n") : null;
}

function lifecycleStatus(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
): PresentedToolCall["status"] {
  const status = text(payload.status)?.toLowerCase();
  if (status === "failed" || status === "declined") return "failed";
  if (status === "stopped") return "stopped";
  if (activity.kind === "tool.completed" || status === "completed") return "completed";
  return "running";
}

function present(activity: OrchestrationThreadActivity): PresentedToolCall | null {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") return null;
  const payload = record(activity.payload) ?? {};
  const command = toolCommand(payload);
  const title = text(payload.title) ?? activity.summary.replace(/\s+complete(?:d)?$/iu, "").trim();
  const detail = expandedDetail(payload, command);
  const files = changedFiles(payload);
  const rawPreview =
    command ??
    text(payload.detail) ??
    rawOutputDetail(payload) ??
    (files.length > 0 ? `${files.length} changed file${files.length === 1 ? "" : "s"}` : null);
  const preview = rawPreview === title ? null : rawPreview;
  return {
    id: activity.id,
    createdAt: activity.createdAt,
    title,
    itemType: text(payload.itemType),
    status: lifecycleStatus(activity, payload),
    preview,
    detail,
    changedFiles: files,
  };
}

export function presentToolCalls(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PresentedToolCall> {
  const presented: Array<PresentedToolCall & { readonly collapseKey: string }> = [];
  for (const activity of [...activities].toSorted((left, right) => {
    if (left.sequence !== undefined && right.sequence !== undefined) {
      return left.sequence - right.sequence;
    }
    return left.createdAt.localeCompare(right.createdAt);
  })) {
    const tool = present(activity);
    if (tool === null) continue;
    const payload = record(activity.payload) ?? {};
    const id = toolCallId(payload);
    const collapseKey = id === null ? `${tool.itemType ?? ""}\u001f${tool.title}` : `id:${id}`;
    const previous = presented.at(-1);
    if (previous?.collapseKey === collapseKey && previous.status === "running") {
      presented[presented.length - 1] = {
        ...previous,
        ...tool,
        preview: tool.preview ?? previous.preview,
        detail: tool.detail ?? previous.detail,
        changedFiles: [...new Set([...previous.changedFiles, ...tool.changedFiles])],
        collapseKey,
      };
    } else {
      presented.push({ ...tool, collapseKey });
    }
  }
  return presented.map(({ collapseKey: _collapseKey, ...tool }) => tool);
}
