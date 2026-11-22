/**
 * Server-only: stamp SourceRef onto operate commands from session claim
 * or platform sourceHint (Discord / Teams / GitHub / Jira bots and bridges).
 * Never trusts client personId/username.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
  AuthClientMetadataDeviceType,
  ClientSourceHint,
  OrchestrationV2Command,
  SessionIdentityClaim,
  SourceChannel,
  SourceRef,
} from "@t3tools/contracts";
import { AuthSessionId, IdentityUsername, PersonId } from "@t3tools/contracts";
import {
  findPersonByDiscordId,
  findPersonByGithubId,
  findPersonByGithubLogin,
  findPersonByJiraAccountId,
  findPersonByJiraEmail,
  findPersonByTeamsActor,
  type IdentityMapPerson,
} from "@t3tools/shared/identityMap";
import {
  buildSourceRefFromClaim,
  resolveSourceChannel,
  sourceRefForMcpClaim,
} from "@t3tools/shared/sourceAttribution";
import * as IdentityService from "./IdentityService.ts";

/**
 * Source for an MCP create, launch, or send. A parent person wins. Otherwise
 * the person claimed on this OAuth session is stamped. No claim stays anonymous.
 * Identity is optional in context so callers without the service keep today's behavior.
 */
export const sourceRefForMcpCaller = Effect.fn("sourceRefForMcpCaller")(function* (input: {
  readonly parentOrigin?: SourceRef | null | undefined;
  readonly clientSessionId?: string | null | undefined;
}) {
  const parentOrigin = input.parentOrigin;
  if (parentOrigin != null && parentOrigin.personId) return parentOrigin;
  const rawSessionId = input.clientSessionId?.trim() ?? "";
  if (rawSessionId.length === 0) return undefined;
  const identity = yield* Effect.serviceOption(IdentityService.IdentityService);
  if (Option.isNone(identity)) return undefined;
  const found = yield* identity.value
    .getSessionClaim(AuthSessionId.make(rawSessionId))
    .pipe(Effect.orElseSucceed(() => ({ claim: null })));
  const claim = found.claim;
  if (claim === null) return undefined;
  const people = yield* identity.value.listMapPeople();
  const person = people.find((entry) => entry.personId === claim.personId);
  return sourceRefForMcpClaim({
    claim: {
      personId: claim.personId,
      username: claim.username,
      displayName: person?.name ?? claim.username,
    },
  });
});

export function sourceRefFromOperateClaim(input: {
  readonly claim: SessionIdentityClaim;
  readonly clientDeviceType?: AuthClientMetadataDeviceType | undefined;
  readonly channelHint?: SourceChannel | undefined;
}): SourceRef {
  const built = buildSourceRefFromClaim({
    personId: input.claim.personId,
    username: input.claim.username,
    channel: resolveSourceChannel({
      deviceType: input.clientDeviceType,
      channelHint: input.channelHint,
    }),
  });
  return {
    channel: built.channel,
    personId: input.claim.personId,
    username: input.claim.username,
  };
}

/**
 * Resolve a map person from a ClientSourceHint channel + actor.
 * Unmapped actors still get a channel stamp without personId (v1 policy).
 */
export function resolvePersonFromSourceHint(
  people: ReadonlyArray<IdentityMapPerson>,
  hint: ClientSourceHint,
): IdentityMapPerson | null {
  const channel = hint.channel;
  const actor = hint.actor;
  const platformId = actor?.platformId?.trim() ?? "";
  const displayName = actor?.displayName?.trim() ?? "";

  if (channel === "discord" && platformId.length > 0) {
    return findPersonByDiscordId(people, platformId);
  }
  if (channel === "teams" && platformId.length > 0) {
    return findPersonByTeamsActor(people, { aadObjectId: platformId, userId: platformId });
  }
  if (channel === "github") {
    if (platformId.length > 0) {
      const byId = findPersonByGithubId(people, platformId);
      if (byId) return byId;
    }
    if (displayName.length > 0) {
      return findPersonByGithubLogin(people, displayName);
    }
    // Some callers put login in platformId when numeric id is unknown.
    if (platformId.length > 0 && !/^\d+$/u.test(platformId)) {
      return findPersonByGithubLogin(people, platformId);
    }
  }
  if (channel === "jira") {
    if (platformId.length > 0) {
      const byAccount = findPersonByJiraAccountId(people, platformId);
      if (byAccount) return byAccount;
    }
    if (displayName.includes("@")) {
      return findPersonByJiraEmail(people, displayName);
    }
  }
  return null;
}

export function sourceRefFromHintAndMap(input: {
  readonly people: ReadonlyArray<IdentityMapPerson>;
  readonly hint: ClientSourceHint;
  readonly clientDeviceType?: AuthClientMetadataDeviceType | undefined;
}): SourceRef {
  const channel = resolveSourceChannel({
    deviceType: input.clientDeviceType,
    channelHint: input.hint.channel,
  });
  const person = resolvePersonFromSourceHint(input.people, input.hint);
  const base: SourceRef = {
    channel,
    ...(input.hint.location !== undefined ? { location: input.hint.location } : {}),
    ...(input.hint.actor !== undefined ? { actor: input.hint.actor } : {}),
  };
  if (person === null) {
    return base;
  }
  return {
    ...base,
    personId: PersonId.make(person.personId),
    username: IdentityUsername.make(person.username),
  };
}

/**
 * Server-authored source for a dispatched message.
 * Priority: session claim → sourceHint+map (integrations) → channel-only for bots.
 */
export function resolveDispatchSource(input: {
  readonly hint: ClientSourceHint | undefined;
  readonly claim: SessionIdentityClaim | null;
  readonly clientDeviceType?: AuthClientMetadataDeviceType | undefined;
  readonly people?: ReadonlyArray<IdentityMapPerson> | undefined;
}): SourceRef | undefined {
  const hint = input.hint;
  if (input.claim !== null) {
    const source = sourceRefFromOperateClaim({
      claim: input.claim,
      clientDeviceType: input.clientDeviceType,
      channelHint: hint?.channel,
    });
    // Merge optional location/actor from hint (e.g. Discord guild) onto claim stamp.
    return {
      ...source,
      ...(hint?.location !== undefined ? { location: hint.location } : {}),
      ...(hint?.actor !== undefined ? { actor: hint.actor } : {}),
    };
  }
  if (hint !== undefined && (input.people?.length ?? 0) > 0) {
    return sourceRefFromHintAndMap({
      people: input.people ?? [],
      hint,
      clientDeviceType: input.clientDeviceType,
    });
  }
  if (hint !== undefined) {
    // Map empty/off: still stamp channel + actor for provenance.
    return {
      channel: resolveSourceChannel({
        deviceType: input.clientDeviceType,
        channelHint: hint.channel,
      }),
      ...(hint.location !== undefined ? { location: hint.location } : {}),
      ...(hint.actor !== undefined ? { actor: hint.actor } : {}),
    };
  }
  return input.clientDeviceType === "bot" ? { channel: "bot" } : undefined;
}

/**
 * Replace client-supplied provenance on a client command with the server's stamp.
 * Clients never author `source` or `originSource`; only `sourceHint` survives as input.
 */
export function stampOrchestrationCommandSource(input: {
  readonly command: OrchestrationV2Command;
  readonly claim: SessionIdentityClaim | null;
  readonly clientDeviceType?: AuthClientMetadataDeviceType | undefined;
  readonly people?: ReadonlyArray<IdentityMapPerson> | undefined;
}): OrchestrationV2Command {
  const command = input.command;
  if (command.type === "thread.create") {
    const { originSource: _clientOrigin, ...rest } = command;
    return rest;
  }
  if (command.type !== "message.dispatch") return command;
  const { sourceHint, source: _clientSource, ...rest } = command;
  const source = resolveDispatchSource({ ...input, hint: sourceHint });
  return source === undefined ? rest : { ...rest, source };
}

/** Build a full SourceRef for in-process bridges (GitHub/Jira) with map resolution. */
export function buildIntegrationSourceRef(input: {
  readonly people: ReadonlyArray<IdentityMapPerson>;
  readonly channel: SourceChannel;
  readonly platformId?: string | null | undefined;
  readonly displayName?: string | null | undefined;
  readonly location?: SourceRef["location"];
}): SourceRef {
  const hint: ClientSourceHint = {
    channel: input.channel,
    ...(input.platformId || input.displayName
      ? {
          actor: {
            ...(input.platformId ? { platformId: input.platformId } : {}),
            ...(input.displayName ? { displayName: input.displayName } : {}),
          },
        }
      : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
  };
  return sourceRefFromHintAndMap({
    people: input.people,
    hint,
  });
}
