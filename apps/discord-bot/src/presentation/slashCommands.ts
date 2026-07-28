import { Discord, Ix } from "dfx";

/**
 * Guild-scoped `/omegent` control commands, with `/agent` as an alias, alongside
 * existing `@Omegent` mentions. Guild registration propagates immediately for
 * try-out; mentions stay the prompt path.
 */
export const OMEGENT_SLASH_COMMAND_NAME = "omegent" as const;

/**
 * Alias command name. Discord has no native command aliases, so `/agent` is
 * registered as a second command that shares the `/omegent` handler.
 */
export const OMEGENT_SLASH_COMMAND_ALIAS = "agent" as const;

export const OMEGENT_SLASH_COMMAND = {
  name: OMEGENT_SLASH_COMMAND_NAME,
  description: "Omegent bot commands (mentions still work for prompts)",
  options: [
    {
      type: Discord.ApplicationCommandOptionType.SUB_COMMAND,
      name: "ask",
      description: "Start or continue a turn (public; same as @Omegent prompt)",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "prompt",
          description: "What you want Omegent to do",
          required: true,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "model",
          description: "Model slug (e.g. gpt-5.4)",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "provider",
          description: "Provider instance id (e.g. codex)",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "base",
          description: "Base branch for a new worktree",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.BOOLEAN,
          name: "local",
          description: "Work without a worktree",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.BOOLEAN,
          name: "plan",
          description: "Run in plan mode",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.BOOLEAN,
          name: "steer",
          description: "Mid-turn: inject this prompt now (default is queue)",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.BOOLEAN,
          name: "queue",
          description: "Mid-turn: park until the turn finishes (default)",
          required: false,
        },
      ],
    },
    {
      type: Discord.ApplicationCommandOptionType.SUB_COMMAND,
      name: "steer",
      description: "Continue work and inject mid-turn (steer into the active turn)",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "prompt",
          description: "What you want Omegent to do",
          required: true,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "model",
          description: "Model slug (e.g. gpt-5.4)",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "provider",
          description: "Provider instance id (e.g. codex)",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.BOOLEAN,
          name: "plan",
          description: "Run in plan mode",
          required: false,
        },
      ],
    },
    {
      type: Discord.ApplicationCommandOptionType.SUB_COMMAND,
      name: "queue",
      description: "Continue work and park mid-turn until the active turn finishes",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "prompt",
          description: "What you want Omegent to do",
          required: true,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "model",
          description: "Model slug (e.g. gpt-5.4)",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "provider",
          description: "Provider instance id (e.g. codex)",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.BOOLEAN,
          name: "plan",
          description: "Run in plan mode",
          required: false,
        },
      ],
    },
    {
      type: Discord.ApplicationCommandOptionType.SUB_COMMAND,
      name: "steernow",
      description: "Inject every parked follow-up into the active turn (FIFO)",
    },
    {
      type: Discord.ApplicationCommandOptionType.SUB_COMMAND,
      name: "help",
      description: "Show the channel info / help pin",
    },
    {
      type: Discord.ApplicationCommandOptionType.SUB_COMMAND,
      name: "stop",
      description: "Stop the active turn in this linked thread",
    },
    {
      type: Discord.ApplicationCommandOptionType.SUB_COMMAND,
      name: "thread-talk",
      description: "Mention-free replies in this linked thread",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "action",
          description: "Turn mention-free mode on/off, or report status",
          required: true,
          choices: [
            { name: "on", value: "on" },
            { name: "off", value: "off" },
            { name: "status", value: "status" },
          ],
        },
      ],
    },
    {
      type: Discord.ApplicationCommandOptionType.SUB_COMMAND,
      name: "link",
      description: "Link this channel or unlinked thread to an existing Omegent thread",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "ref",
          description: "Omegent thread id or web URL containing ?thread=",
          required: true,
        },
      ],
    },
    {
      type: Discord.ApplicationCommandOptionType.SUB_COMMAND,
      name: "refresh-indicators",
      description: "Refresh Discord thread title badges (PR/VCS indicators)",
    },
    {
      type: Discord.ApplicationCommandOptionType.SUB_COMMAND,
      name: "assign",
      description: "Assign linked PR(s) on this thread (default: you via identity map)",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "github",
          description: "GitHub login (default: you / @me from the identity map)",
          required: false,
        },
      ],
    },
  ],
} as const;

export type ThreadTalkSlashAction = "on" | "off" | "status";

export function isThreadTalkSlashAction(value: string): value is ThreadTalkSlashAction {
  return value === "on" || value === "off" || value === "status";
}

/** Build a standard interaction message response. */
export function slashReply(
  content: string,
  options?: { readonly ephemeral?: boolean },
): ReturnType<typeof Ix.response> {
  return Ix.response({
    type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      ...(options?.ephemeral === true ? { flags: Discord.MessageFlags.Ephemeral } : {}),
    },
  });
}

/**
 * Ack within Discord's ~3s interaction window when work continues in the background.
 * Follow up with `updateOriginalWebhookMessage(application_id, token, …)`.
 *
 * Note: dfx's `Ix.response` typing omits `data` on deferred type 5, but Discord accepts
 * ephemeral flags there — return the REST payload shape directly.
 */
export function slashDefer(options?: {
  readonly ephemeral?: boolean;
}): Discord.CreateInteractionResponseRequest {
  if (options?.ephemeral === true) {
    return {
      type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: Discord.MessageFlags.Ephemeral },
    };
  }
  return {
    type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}

export function threadTalkSlashReply(input: {
  readonly action: ThreadTalkSlashAction;
  readonly enabled: boolean;
}): ReturnType<typeof Ix.response> {
  const content = input.enabled
    ? "Thread-talk is **on**. New human messages in this linked thread will be sent to Omegent without requiring a mention."
    : "Thread-talk is **off**. Mention `@Omegent` or use `/omegent` to send a message to Omegent.";
  // on/off change shared thread policy → public; status is personal
  return slashReply(content, { ephemeral: input.action === "status" });
}

/** Preview used in public `/omegent ask` acks (keep Discord-message friendly). */
export function formatAskSlashAck(input: {
  readonly displayName: string;
  readonly prompt: string;
  readonly plan: boolean;
  readonly local: boolean;
  readonly followUpDelivery?: "steer" | "queue";
}): string {
  const flags = [
    input.plan ? "`--plan`" : null,
    input.local ? "`--local`" : null,
    input.followUpDelivery === "queue"
      ? "`--queue`"
      : input.followUpDelivery === "steer"
        ? "`--steer`"
        : null,
  ].filter((value): value is string => value !== null);
  const flagSuffix = flags.length > 0 ? ` (${flags.join(" ")})` : "";
  const preview =
    input.prompt.length > 280 ? `${input.prompt.slice(0, 277).trimEnd()}…` : input.prompt;
  return `**${input.displayName}** asked${flagSuffix}:\n${preview}`;
}
