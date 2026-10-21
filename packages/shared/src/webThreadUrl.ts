/**
 * Browser thread URL shared by Discord, Teams, and Jira.
 * `{base}/?thread={threadId}`.
 *
 * The hosted app route `/threads/{environmentId}/{threadId}` is a different
 * link. Outbound comments do not use it.
 */
export function buildWebThreadUrl(
  webUiBaseUrl: string | null | undefined,
  threadId: string | null | undefined,
): string | null {
  const base = webUiBaseUrl?.trim();
  const id = threadId?.trim();
  if (base === undefined || base.length === 0 || id === undefined || id.length === 0) {
    return null;
  }
  return `${base.replace(/\/+$/u, "")}/?thread=${id}`;
}

/** Clickable label Discord answers already use for that URL. */
export function formatWebThreadOpenLink(url: string): string {
  return `[Open](${url})`;
}
