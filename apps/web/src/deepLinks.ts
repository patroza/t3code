/**
 * Omegent web deep links:
 *   `/?thread={threadId}`
 *   `/?thread={threadId}#message-{messageId}`
 *   `/#message-{messageId}` (when already on a thread route)
 */

export type OmegentDeepLink = {
  readonly threadId: string | null;
  readonly messageId: string | null;
};

/** Parse `#message-{id}` (or bare `#id` with message- prefix required). */
export function parseMessageIdFromHash(hash: string | null | undefined): string | null {
  const raw = (hash ?? "").trim();
  if (raw === "") return null;
  const body = raw.startsWith("#") ? raw.slice(1) : raw;
  const match = /^message-(.+)$/u.exec(body);
  const id = match?.[1]?.trim() ?? "";
  return id === "" ? null : id;
}

export function parseOmegentDeepLink(url: URL): OmegentDeepLink {
  const threadParam = url.searchParams.get("thread")?.trim() ?? "";
  return {
    threadId: threadParam === "" ? null : threadParam,
    messageId: parseMessageIdFromHash(url.hash),
  };
}

/** Build the client hash fragment for a chat message id. */
export function messageDeepLinkHash(messageId: string): string {
  return `#message-${messageId.trim()}`;
}
