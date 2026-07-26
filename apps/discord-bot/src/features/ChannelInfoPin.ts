// @effect-diagnostics globalFetch:off globalFetchInEffect:off unknownInEffectCatch:off anyUnknownInErrorContext:off outdatedApi:off
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { DiscordConfig } from "dfx";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

import { preferredModelSelection, type DiscordBotConfig } from "../config.ts";
import {
  CHANNEL_INFO_PIN_MARKER,
  LEGACY_CHANNEL_INFO_PIN_MARKERS,
  renderChannelInfoPin,
  resolveGitHubUrlForWorkspace,
} from "../presentation/channelInfoPin.ts";

/** Detect the bot's own channel-info pin, including pre-rebrand (legacy) markers. */
const isChannelInfoPin = (content: string | undefined): boolean => {
  if (content === undefined) return false;
  if (content.includes(CHANNEL_INFO_PIN_MARKER)) return true;
  return LEGACY_CHANNEL_INFO_PIN_MARKERS.some((marker) => content.includes(marker));
};

interface DiscordMessageSummary {
  readonly id: string;
  readonly content?: string;
}

export interface ChannelInfoPinMessageRef {
  readonly channelId: string;
  readonly messageId: string;
}

async function discordApiJson<T>(input: {
  readonly baseUrl: string;
  readonly botToken: string;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
}): Promise<T> {
  const response = await globalThis.fetch(`${input.baseUrl.replace(/\/+$/u, "")}${input.path}`, {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bot ${input.botToken}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (t3-discord-bot, 0.0.0)",
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Discord API ${input.method ?? "GET"} ${input.path} failed (${response.status}): ${body}`,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function discordApiVoid(input: {
  readonly baseUrl: string;
  readonly botToken: string;
  readonly path: string;
  readonly method: string;
}): Promise<void> {
  const response = await globalThis.fetch(`${input.baseUrl.replace(/\/+$/u, "")}${input.path}`, {
    method: input.method,
    headers: {
      Authorization: `Bot ${input.botToken}`,
      "User-Agent": "DiscordBot (t3-discord-bot, 0.0.0)",
    },
  });
  if (!response.ok && response.status !== 204) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Discord API ${input.method} ${input.path} failed (${response.status}): ${body}`,
    );
  }
}

export const ensureChannelInfoPin = (input: {
  readonly channelId: string;
  readonly workspaceRoot: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectDefaultModelSelection?: ModelSelection | null;
  readonly botConfig: DiscordBotConfig;
}) =>
  Effect.gen(function* () {
    const discordConfig = yield* DiscordConfig.DiscordConfig;
    const botToken = Redacted.value(discordConfig.token);
    const baseUrl = discordConfig.rest.baseUrl;
    const githubUrl = yield* Effect.tryPromise({
      try: () => resolveGitHubUrlForWorkspace(input.workspaceRoot),
      catch: (cause) => cause,
    }).pipe(Effect.orElseSucceed(() => null));
    const supportedProviders = input.providers
      .filter((provider) => provider.models.length > 0)
      .toSorted((left, right) => String(left.instanceId).localeCompare(String(right.instanceId)));
    const availableProviders = input.providers.filter(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.availability !== "unavailable" &&
        provider.models.length > 0,
    );
    const defaultModelSelection =
      availableProviders.length === 0
        ? null
        : preferredModelSelection({
            config: input.botConfig,
            providers: availableProviders,
            projectDefault: input.projectDefaultModelSelection ?? null,
          });
    const desiredContent = renderChannelInfoPin({
      githubUrl,
      workspaceRoot: input.workspaceRoot,
      providers: supportedProviders,
      defaultModelSelection,
    });

    const pinned = yield* Effect.tryPromise({
      try: () =>
        discordApiJson<ReadonlyArray<DiscordMessageSummary>>({
          baseUrl,
          botToken,
          path: `/channels/${input.channelId}/pins`,
        }),
      catch: (cause) => cause,
    });

    const infoPins = pinned.filter((message) => isChannelInfoPin(message.content));
    const existing = infoPins[0] ?? null;
    const stale = infoPins.slice(1);
    let pinMessageId = existing?.id ?? null;

    if (existing !== null) {
      if ((existing.content ?? "") !== desiredContent) {
        const updated = yield* Effect.tryPromise({
          try: () =>
            discordApiJson({
              baseUrl,
              botToken,
              path: `/channels/${input.channelId}/messages/${existing.id}`,
              method: "PATCH",
              body: { content: desiredContent },
            }),
          catch: (cause) => cause,
        }).pipe(Effect.result);
        if (Result.isFailure(updated)) {
          // Content was historically over 2000 chars; replace the pin instead of failing help.
          yield* Effect.logWarning("Channel info pin PATCH failed; recreating pin message", {
            channelId: input.channelId,
            existingMessageId: existing.id,
            contentLength: desiredContent.length,
            error: String(updated.failure),
          });
          const created = yield* Effect.tryPromise({
            try: () =>
              discordApiJson<{ readonly id: string }>({
                baseUrl,
                botToken,
                path: `/channels/${input.channelId}/messages`,
                method: "POST",
                body: { content: desiredContent },
              }),
            catch: (cause) => cause,
          });
          pinMessageId = created.id;
          yield* Effect.tryPromise({
            try: () =>
              discordApiVoid({
                baseUrl,
                botToken,
                path: `/channels/${input.channelId}/pins/${created.id}`,
                method: "PUT",
              }),
            catch: (cause) => cause,
          });
          yield* Effect.tryPromise({
            try: () =>
              discordApiVoid({
                baseUrl,
                botToken,
                path: `/channels/${input.channelId}/pins/${existing.id}`,
                method: "DELETE",
              }),
            catch: (cause) => cause,
          }).pipe(Effect.catch(() => Effect.void));
        }
      }
    } else {
      const created = yield* Effect.tryPromise({
        try: () =>
          discordApiJson<{ readonly id: string }>({
            baseUrl,
            botToken,
            path: `/channels/${input.channelId}/messages`,
            method: "POST",
            body: { content: desiredContent },
          }),
        catch: (cause) => cause,
      });
      pinMessageId = created.id;
      yield* Effect.tryPromise({
        try: () =>
          discordApiVoid({
            baseUrl,
            botToken,
            path: `/channels/${input.channelId}/pins/${created.id}`,
            method: "PUT",
          }),
        catch: (cause) => cause,
      });
    }

    for (const message of stale) {
      if (message.id === pinMessageId) continue;
      yield* Effect.tryPromise({
        try: () =>
          discordApiVoid({
            baseUrl,
            botToken,
            path: `/channels/${input.channelId}/pins/${message.id}`,
            method: "DELETE",
          }),
        catch: (cause) => cause,
      }).pipe(Effect.catch(() => Effect.void));
    }

    return {
      channelId: input.channelId,
      messageId: pinMessageId ?? "",
    } satisfies ChannelInfoPinMessageRef;
  });
