/**
 * Server-only: stamp SourceRef onto operate commands from session claim
 * or platform sourceHint (Discord / GitHub / Jira bots and bridges).
 * Never trusts client personId/username.
 */
import type {
  AuthClientMetadataDeviceType,
  ClientSourceHint,
  OrchestrationCommand,
  SessionIdentityClaim,
  SourceChannel,
  SourceRef,
} from "@t3tools/contracts";
import { IdentityUsername, PersonId } from "@t3tools/contracts";
import {
  findPersonByDiscordId,
  findPersonByGithubId,
  findPersonByGithubLogin,
  findPersonByJiraAccountId,
  findPersonByJiraEmail,
  type IdentityMapPerson,
} from "@t3tools/shared/identityMap";
import { buildSourceRefFromClaim, resolveSourceChannel } from "@t3tools/shared/sourceAttribution";

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
 * Attach server-authored source to turn.start commands.
 * Priority: session claim → sourceHint+map (integrations) → channel-only for bots.
 */
export function stampOrchestrationCommandSource(input: {
  readonly command: OrchestrationCommand;
  readonly claim: SessionIdentityClaim | null;
  readonly clientDeviceType?: AuthClientMetadataDeviceType | undefined;
  readonly people?: ReadonlyArray<IdentityMapPerson> | undefined;
}): OrchestrationCommand {
  if (input.command.type !== "thread.turn.start") {
    return input.command;
  }

  const hint = input.command.sourceHint;
  let source: SourceRef | undefined;

  if (input.claim !== null) {
    source = sourceRefFromOperateClaim({
      claim: input.claim,
      clientDeviceType: input.clientDeviceType,
      channelHint: hint?.channel,
    });
    // Merge optional location/actor from hint (e.g. Discord guild) onto claim stamp.
    if (hint?.location !== undefined || hint?.actor !== undefined) {
      source = {
        ...source,
        ...(hint.location !== undefined ? { location: hint.location } : {}),
        ...(hint.actor !== undefined ? { actor: hint.actor } : {}),
      };
    }
  } else if (hint !== undefined && (input.people?.length ?? 0) > 0) {
    source = sourceRefFromHintAndMap({
      people: input.people ?? [],
      hint,
      clientDeviceType: input.clientDeviceType,
    });
  } else if (hint !== undefined) {
    // Map empty/off: still stamp channel + actor for provenance.
    source = {
      channel: resolveSourceChannel({
        deviceType: input.clientDeviceType,
        channelHint: hint.channel,
      }),
      ...(hint.location !== undefined ? { location: hint.location } : {}),
      ...(hint.actor !== undefined ? { actor: hint.actor } : {}),
    };
  } else if (input.clientDeviceType === "bot") {
    source = { channel: "bot" };
  }

  // Drop sourceHint from the command stored in the engine (source is authoritative).
  const { sourceHint: _dropped, ...withoutHint } = input.command;
  void _dropped;
  if (source === undefined) {
    return withoutHint as OrchestrationCommand;
  }
  return {
    ...withoutHint,
    source,
  } as OrchestrationCommand;
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
