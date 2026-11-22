import type { App } from "@microsoft/teams.apps";

type MessageContext = Parameters<Parameters<App["message"]>[1]>[0];
// Message edits carry the same conversation data, without the SDK's message helper methods.
export type TeamsMessageContext = Pick<MessageContext, "api" | "send" | "reply"> & {
  activity: Pick<
    MessageContext["activity"],
    | "id"
    | "text"
    | "timestamp"
    | "from"
    | "recipient"
    | "conversation"
    | "channelData"
    | "channelId"
    | "serviceUrl"
    | "replyToId"
    | "attachments"
    | "entities"
  >;
};

export function mentionsTeamsRecipient(activity: {
  readonly recipient?: { readonly id?: string };
  readonly entities?: ReadonlyArray<{
    readonly type: string;
    readonly mentioned?: { readonly id?: string };
  }>;
}): boolean {
  const recipient = activity.recipient?.id;
  return (
    recipient !== undefined &&
    activity.entities?.some(
      (entity) => entity.type === "mention" && entity.mentioned?.id === recipient,
    ) === true
  );
}

/** Both Teams SDK entry points treat a newly addressed edit as message intake. */
export function registerTeamsMessageEvents(
  app: Pick<App, "on">,
  handler: (context: TeamsMessageContext, edited: boolean) => Promise<void>,
): void {
  app.on("message", (context) => handler(context, false));
  app.on("editMessage", (context) => {
    if (!mentionsTeamsRecipient(context.activity)) return;
    return handler(context, true);
  });
}
