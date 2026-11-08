// Publish oversized Jira replies under the assigned Confluence space and link the response heading.
// Fall back to an issue attachment when no space is assigned or Confluence rejects the write.
import type { JiraAdfDoc, JiraAdfNode } from "./JiraMarkdown.ts";

export type JiraConfluencePageTarget = {
  readonly spaceKey: string;
  readonly parentTitles: ReadonlyArray<string>;
};

export function parseJiraConfluencePages(
  raw: string,
): ReadonlyMap<string, JiraConfluencePageTarget> {
  const map = new Map<string, JiraConfluencePageTarget>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const project = trimmed.slice(0, colon).trim().toUpperCase();
    const path = trimmed
      .slice(colon + 1)
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    const spaceKey = path[0]?.toUpperCase();
    if (project.length === 0 || spaceKey === undefined || spaceKey.length === 0) continue;
    map.set(project, { spaceKey, parentTitles: path.slice(1) });
  }
  return map;
}

export function confluencePageForProject(
  pages: ReadonlyMap<string, JiraConfluencePageTarget>,
  projectKey: string,
): JiraConfluencePageTarget | null {
  return pages.get(projectKey.trim().toUpperCase()) ?? null;
}

/** Gateway Jira base → Confluence REST base on the same cloud id. */
export function confluenceRestBase(jiraBaseUrl: string): string | null {
  const match = /^(https:\/\/api\.atlassian\.com)\/ex\/jira\/([^/]+)/iu.exec(jiraBaseUrl.trim());
  if (match === null) return null;
  return `${match[1]}/ex/confluence/${match[2]}/wiki`;
}

export function confluenceBrowseUrl(input: {
  readonly siteBase: string;
  readonly spaceKey: string;
  readonly pageId: string;
  readonly title: string;
  readonly heading: string;
}): string {
  const site = input.siteBase.replace(/\/+$/u, "");
  const slug = encodeURIComponent(input.title.trim()).replace(/%20/gu, "+");
  return `${site}/wiki/spaces/${encodeURIComponent(input.spaceKey)}/pages/${encodeURIComponent(input.pageId)}/${slug}#${confluenceHeadingAnchor(input.heading)}`;
}

/** Confluence Cloud heading fragments are the heading text, lowercased, with spaces as hyphens. */
export function confluenceHeadingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function appendAdfSection(
  existing: unknown,
  heading: string,
  section: JiraAdfDoc,
): JiraAdfDoc {
  const head: JiraAdfNode = {
    type: "heading",
    attrs: { level: 2 },
    content: [{ type: "text", text: heading }],
  };
  return {
    type: "doc",
    version: 1,
    content: [...readAdfContent(existing), head, ...section.content],
  };
}

export function jiraAttachmentBrowseUrl(
  siteBase: string | null,
  attachment: { readonly id: string; readonly content?: string | null | undefined },
): string {
  if (siteBase !== null && siteBase.trim().length > 0) {
    return `${siteBase.replace(/\/+$/u, "")}/rest/api/3/attachment/content/${encodeURIComponent(attachment.id)}`;
  }
  if (
    attachment.content !== undefined &&
    attachment.content !== null &&
    /^https:\/\//iu.test(attachment.content)
  ) {
    return attachment.content;
  }
  return `https://api.atlassian.com/rest/api/3/attachment/content/${encodeURIComponent(attachment.id)}`;
}

export function jiraResponseStamp(iso: string): string {
  const compact = iso.trim().replace(/[-:.]/gu, "").toLowerCase();
  return `response-${compact}`;
}

/** Issue attachment name. Jira rejects path separators and most punctuation. */
export function jiraAttachmentFilename(issueKey: string, stamp: string): string {
  const clean = (value: string, fallback: string) => {
    const stripped = value.replace(/[^A-Za-z0-9._-]+/gu, "").replace(/^\.+/u, "");
    return stripped.length > 0 ? stripped : fallback;
  };
  return `${clean(issueKey, "issue")}-${clean(stamp, "response")}.md`;
}

/**
 * Browse URL from a Confluence page `_links` pair (`base` + `webui`), plus the heading fragment.
 * Returns null when either link is missing so the caller can try `serverInfo` instead.
 */
export function confluenceLinksUrl(
  links:
    | { readonly base?: string | null | undefined; readonly webui?: string | null | undefined }
    | null
    | undefined,
  heading: string,
): string | null {
  const base = links?.base?.trim() ?? "";
  const webui = links?.webui?.trim() ?? "";
  if (base.length === 0 || webui.length === 0) return null;
  const joined = `${base.replace(/\/+$/u, "")}/${webui.replace(/^\/+/u, "")}`;
  return `${joined}#${confluenceHeadingAnchor(heading)}`;
}

/**
 * Parse a Confluence v2 `body.atlas_doc_format.value` string.
 * Null means the body is missing or not a document — callers must not replace the page.
 */
export function readConfluenceAtlasDoc(body: unknown): JiraAdfDoc | null {
  const value = atlasDocValue(body);
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const content = (parsed as { content?: unknown }).content;
    if (!Array.isArray(content)) return null;
    return {
      type: "doc",
      version: 1,
      content: content.filter(
        (node): node is JiraAdfNode => node !== null && typeof node === "object",
      ),
    };
  } catch {
    return null;
  }
}

function atlasDocValue(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const record = body as { atlas_doc_format?: unknown; value?: unknown };
  const nested = record.atlas_doc_format;
  const value =
    nested !== null && typeof nested === "object" && "value" in nested
      ? (nested as { value?: unknown }).value
      : record.value;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readAdfContent(existing: unknown): ReadonlyArray<JiraAdfNode> {
  if (existing === null || typeof existing !== "object") return [];
  const content = (existing as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.filter((node): node is JiraAdfNode => node !== null && typeof node === "object");
}
