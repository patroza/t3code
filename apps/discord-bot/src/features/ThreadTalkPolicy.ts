import type { ThreadLink } from "../store/ThreadLinkStore.ts";

export type ThreadTalkCommand =
  | { readonly kind: "set"; readonly enabled: boolean }
  | { readonly kind: "status" };

export function parseThreadTalkCommand(raw: string): ThreadTalkCommand | null {
  const normalized = raw.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
  if (normalized === "thread-talk on") return { kind: "set", enabled: true };
  if (normalized === "thread-talk off") return { kind: "set", enabled: false };
  if (normalized === "thread-talk status") return { kind: "status" };
  return null;
}

export function threadTalkEnabled(link: ThreadLink | null): boolean {
  return link?.threadTalkMode === "all-messages";
}

export function formatUnmentionedDiscordPrompt(input: {
  readonly content: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly messageId: string;
}): string {
  return [
    `Discord message from ${input.authorName} (user ${input.authorId}, message ${input.messageId}):`,
    "",
    input.content,
  ].join("\n");
}
