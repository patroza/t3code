// @effect-diagnostics anyUnknownInErrorContext:off
import { DiscordBotConfig } from "../config.ts";
import { Discord, DiscordConfig, DiscordREST, UI } from "dfx";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import {
  BotResponseTransport,
  BotTransportError,
  messageUpdateError,
  type BotMessageFields,
} from "../features/BotResponseTransport.ts";
import { upsertThreadInfoPin } from "../features/ThreadInfoPin.ts";
import { createMessageWithAttachments, DiscordUploadError } from "../presentation/discordFiles.ts";
import { turnContinueCustomId, turnStopCustomId } from "../presentation/messages.ts";

const transportError = (cause: unknown) => new BotTransportError({ cause });

/** Discord wire controls stay in the Discord adapter, outside the shared response runner. */
export function discordMessageFields(fields: BotMessageFields) {
  return {
    content: fields.content,
    ...(fields.actions === undefined
      ? {}
      : {
          components:
            fields.actions.length === 0
              ? []
              : UI.grid([
                  fields.actions.map((action) =>
                    UI.button({
                      custom_id:
                        action.command === "stop"
                          ? turnStopCustomId(action.threadId)
                          : action.command === "continue"
                            ? turnContinueCustomId(action.threadId)
                            : `t3_${action.command}:${action.threadId}:${action.requestId}`,
                      label: action.label,
                      style:
                        action.command === "approve"
                          ? Discord.ButtonStyleTypes.SUCCESS
                          : action.command === "continue"
                            ? Discord.ButtonStyleTypes.PRIMARY
                            : Discord.ButtonStyleTypes.DANGER,
                    }),
                  ),
                ]),
        }),
  };
}

export const layer = Layer.effect(
  BotResponseTransport,
  Effect.gen(function* () {
    const rest = yield* DiscordREST;
    const config = yield* DiscordConfig.DiscordConfig;
    const botConfig = yield* DiscordBotConfig;
    return BotResponseTransport.of({
      platform: "discord",
      normalizeContent: (content) => content.replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim(),
      config: botConfig,
      contentLimit: 2000,
      fileLimit: 10,
      uploadLimitBytes: 10_000_000,
      getMyUser: () => rest.getMyUser().pipe(Effect.mapError(transportError)),
      getChannel: (id) => rest.getChannel(id).pipe(Effect.mapError(transportError)),
      getMessage: (id, messageId) =>
        rest.getMessage(id, messageId).pipe(Effect.mapError(transportError)),
      listMessages: (id, options) =>
        rest.listMessages(id, options).pipe(Effect.mapError(transportError)),
      createMessage: (id, fields) =>
        rest.createMessage(id, discordMessageFields(fields)).pipe(Effect.mapError(transportError)),
      updateMessage: (id, messageId, fields) =>
        rest
          .updateMessage(id, messageId, discordMessageFields(fields))
          .pipe(Effect.mapError(messageUpdateError)),
      deleteMessage: (id, messageId) =>
        rest.deleteMessage(id, messageId).pipe(Effect.asVoid, Effect.mapError(messageUpdateError)),
      updateChannel: (id, fields) =>
        rest.updateChannel(id, fields).pipe(Effect.mapError(transportError)),
      createMessageWithFiles: (id, content, files) =>
        Effect.tryPromise({
          try: () =>
            createMessageWithAttachments({
              baseUrl: config.rest.baseUrl,
              botToken: Redacted.value(config.token),
              channelId: id,
              content,
              files,
            }),
          catch: (cause) =>
            cause instanceof DiscordUploadError ? cause : new DiscordUploadError(String(cause)),
        }),
      upsertThreadInfo: ({ conversationId, threadId, config: botConfig, ...input }) =>
        upsertThreadInfoPin({
          ...input,
          discordThreadId: conversationId,
          t3ThreadId: threadId,
          botConfig,
        }).pipe(
          Effect.mapError(transportError),
          Effect.provideService(DiscordREST, rest),
          Effect.provideService(DiscordConfig.DiscordConfig, config),
        ),
    });
  }),
);
