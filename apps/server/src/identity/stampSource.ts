/**
 * Server-only: stamp SourceRef onto operate commands from session claim.
 * Never trusts client personId/username.
 */
import type {
  AuthClientMetadataDeviceType,
  OrchestrationCommand,
  SessionIdentityClaim,
  SourceRef,
} from "@t3tools/contracts";
import { buildSourceRefFromClaim, resolveSourceChannel } from "@t3tools/shared/sourceAttribution";

export function sourceRefFromOperateClaim(input: {
  readonly claim: SessionIdentityClaim;
  readonly clientDeviceType?: AuthClientMetadataDeviceType | undefined;
  readonly channelHint?: SourceRef["channel"] | undefined;
}): SourceRef {
  const built = buildSourceRefFromClaim({
    personId: input.claim.personId,
    username: input.claim.username,
    channel: resolveSourceChannel({
      deviceType: input.clientDeviceType,
      channelHint: input.channelHint,
    }),
  });
  // Claim brands are already PersonId / IdentityUsername on SessionIdentityClaim.
  return {
    channel: built.channel,
    personId: input.claim.personId,
    username: input.claim.username,
  };
}

/**
 * Attach server-authored source to turn.start commands when a claim is present.
 * Bot sessions (no claim) leave source unset until integration stamping lands.
 */
export function stampOrchestrationCommandSource(input: {
  readonly command: OrchestrationCommand;
  readonly claim: SessionIdentityClaim | null;
  readonly clientDeviceType?: AuthClientMetadataDeviceType | undefined;
}): OrchestrationCommand {
  if (input.claim === null) {
    return input.command;
  }
  if (input.command.type !== "thread.turn.start") {
    return input.command;
  }
  return {
    ...input.command,
    source: sourceRefFromOperateClaim({
      claim: input.claim,
      clientDeviceType: input.clientDeviceType,
    }),
  };
}
