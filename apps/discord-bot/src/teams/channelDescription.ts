// @effect-diagnostics globalFetch:off globalPromise:off globalDate:off preferSchemaOverJson:off
import * as Schema from "effect/Schema";
import { parseTopicShortName } from "../presentation/mentions.ts";

const Channel = Schema.Struct({ id: Schema.String, description: Schema.NullOr(Schema.String) });
const Token = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number });
const decodeChannel = Schema.decodeUnknownSync(Channel);
const decodeToken = Schema.decodeUnknownSync(Token);

export interface TeamsDescriptionPolicy {
  readonly useChannelDescription?: boolean | undefined;
  readonly descriptionProjectShortNames?: ReadonlyArray<string> | undefined;
  readonly projectShortName?: string | undefined;
}

export function validateTeamsDescriptionPolicy(policy: TeamsDescriptionPolicy): void {
  if (policy.useChannelDescription !== true) return;
  const aliases = policy.descriptionProjectShortNames;
  if (
    !aliases?.length ||
    aliases.some((alias) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(alias)) ||
    (policy.projectShortName !== undefined && !aliases.includes(policy.projectShortName))
  ) {
    throw new Error(
      "Description tags require explicit approved project aliases including the default",
    );
  }
}

/** Same project parser as Discord; descriptions cannot widen the operator's alias policy. */
export function teamsDescriptionProject(description: string, policy: TeamsDescriptionPolicy) {
  if (policy.useChannelDescription !== true) return policy.projectShortName;
  validateTeamsDescriptionPolicy(policy);
  const tagged = parseTopicShortName(description);
  if (tagged === null && /\bomegent-link(?:-|\b)/iu.test(description)) {
    throw new Error("Teams description contains an invalid project link tag");
  }
  if (tagged !== null && !policy.descriptionProjectShortNames?.includes(tagged)) {
    throw new Error(`Teams description project '${tagged}' is not approved for this channel`);
  }
  return tagged ?? policy.projectShortName;
}

/** One reader per bot process. Team/channel/tenant cache keys prevent cross-workspace reuse. */
export function makeTeamsChannelDescriptionReader(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}) {
  const request = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const tokens = new Map<string, { value: string; expires: number }>();
  const descriptions = new Map<string, { value: string; expires: number }>();
  return async (location: {
    readonly tenantId: string;
    readonly teamId: string;
    readonly channelId: string;
    readonly assertActive: () => void;
  }): Promise<string> => {
    location.assertActive();
    const key = JSON.stringify([location.tenantId, location.teamId, location.channelId]);
    const cached = descriptions.get(key);
    if (cached && cached.expires > now()) return cached.value;
    let token = tokens.get(location.tenantId);
    if (!token || token.expires < now() + 60_000) {
      const response = await request(
        `https://login.microsoftonline.com/${encodeURIComponent(location.tenantId)}/oauth2/v2.0/token`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          body: new URLSearchParams({
            client_id: input.clientId,
            client_secret: input.clientSecret,
            grant_type: "client_credentials",
            scope: "https://graph.microsoft.com/.default",
          }),
        },
      );
      if (!response.ok)
        throw new Error(`Teams metadata authentication failed (${response.status})`);
      const body = decodeToken(await response.json());
      token = { value: body.access_token, expires: now() + body.expires_in * 1000 };
      tokens.set(location.tenantId, token);
    }
    location.assertActive();
    const response = await request(
      `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(location.teamId)}/channels/${encodeURIComponent(location.channelId)}?$select=id,description`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token.value}` },
      },
    );
    if (!response.ok) {
      throw new Error(
        `Teams channel description read failed (${response.status}); consent to ChannelSettings.Read.Group for this team`,
      );
    }
    const channel = decodeChannel(await response.json());
    location.assertActive();
    if (channel.id !== location.channelId)
      throw new Error("Teams metadata channel identity mismatch");
    const value = channel.description ?? "";
    descriptions.set(key, { value, expires: now() + 30_000 });
    return value;
  };
}
