# Microsoft Teams Intake Module

This repository now includes a Teams intake path inside [`apps/discord-bot`](apps/discord-bot).

It does three things:

1. Polls a configured list of Teams channels through Microsoft Graph.
2. Detects one or more configured trigger modes per channel.
3. Creates or reuses a Discord thread, starts a T3 investigation thread, and streams the analysis back into Discord.

## What The Module Does

- Each Teams channel is configured with:
  - the Teams `teamId` and `channelId`
  - the target Discord channel id
  - the T3 project short name
  - company and environment labels
  - company/environment/problem keywords for matching
- Each channel can enable any combination of these escalation modes:
  - automatic assessment of new messages for German problem reports
  - allowlisted internal-user reactions, such as `eyes` or `🚨`
  - allowlisted internal-user tag messages, such as `#investigate`, typically sent as a reply to the message being escalated
- Explicit Teams `@mention` traffic is treated as a forced trigger on top of those modes.
- Automatic assessment only runs on newly seen messages.
- Reaction triggers are re-evaluated on already-seen messages, so an internal user can flag an older message later without reposting it.
- Tag triggers are only accepted from configured internal user ids on a per-channel basis.
- The first detected message for a Teams thread opens a Discord thread under the mapped Discord channel.
- Later matching messages in the same Teams thread continue the same T3 thread instead of opening duplicates.
- Any image attachments on the target Teams message are copied into the Discord seed message and passed into the T3 investigation turn.
- The intake prompt also includes immediate preceding channel history from the prior two hours, stopping at the previous already-investigated Teams root.

## Trigger Configuration

Per-channel configuration supports these fields:

- `automaticAssessmentEnabled`
  - Default: `true`
  - Enables German problem-report assessment for newly seen messages in that channel.
- `internalUserIds`
  - Microsoft Entra user ids allowed to trigger manual escalations in that channel.
- `reactionTriggerTypes`
  - Reaction types accepted from `internalUserIds`, for example `["eyes", "🚨"]`.
- `messageTagTriggers`
  - Text markers accepted from `internalUserIds`, for example `["#investigate", "#triage"]`.

You can enable one, two, or all three of those modes per channel.

## Current Limits

- The implementation uses Microsoft Graph application auth for reading channel messages.
- For write-back to Teams, the implementation only supports an optional channel webhook acknowledgement.
- It does **not** implement a full Bot Framework HTTPS endpoint yet.
- Because of that, “respond to @ trigger messages” currently means:
  - detect the mention
  - create the Discord/T3 incident thread
  - optionally post a short acknowledgement back to Teams through a configured incoming webhook
- If you need native threaded replies in Teams as the bot, add a Bot Framework endpoint later.

## Config Files

Set these env vars for the Discord bot process:

- `TEAMS_ENABLED=1`
- `TEAMS_TENANT_ID=<entra tenant id>`
- `TEAMS_CLIENT_ID=<app registration client id>`
- `TEAMS_CLIENT_SECRET=<app registration client secret>`
- `TEAMS_CHANNELS_PATH=/absolute/path/to/teams.channels.json`
- `TEAMS_POLL_INTERVAL_SECONDS=60`
- `TEAMS_BOT_DISPLAY_NAME=T3 Code`

Use [`apps/discord-bot/teams.channels.example.json`](apps/discord-bot/teams.channels.example.json) as the starting point.

## Polling Window

- On normal weekdays, the poller scans the last 24 hours of channel traffic.
- On Saturday, Sunday, and Monday, it scans from Friday 00:00 UTC onward so weekend reports are still in scope on Monday morning.

## Microsoft Setup

The setup depends on whether you only need scan-and-escalate, or also want native in-Teams bot replies.

### Minimum Setup For This Module

This is enough for the code currently in the repo.

1. Create a Microsoft Entra app registration.
2. Add a client secret.
3. Grant Microsoft Graph application permissions needed to read channel messages.
4. Grant admin consent in the tenant.
5. Install the Teams app where you want resource-specific consent, if you use RSC-scoped access.
6. Create one Teams incoming webhook per channel only if you want acknowledgements posted back to Teams.

### Permissions And Consent

From Microsoft Learn:

- Teams bots only receive channel messages by default when directly mentioned.
- To receive all channel messages without mentions, Teams supports resource-specific consent with `ChannelMessage.Read.Group`.
- Microsoft Graph permissions that expose organization-wide data require admin consent in Microsoft Entra.
- Teams app admins can review both Microsoft Graph permissions and RSC permissions in the Teams admin center.

Operationally, that means:

- If you want least-privilege per team/channel behavior, use Teams app installation plus RSC.
- If your tenant instead grants broader Graph application permissions, your security review should treat that as tenant-wide read access.

## Recommended Org Approval Path

1. Security reviews the Entra app registration and the exact Graph/RSC permissions requested.
2. Teams admins verify the app in Teams admin center and review the Permissions tab.
3. Team owners approve installation into the specific teams/channels that should be monitored.
4. Discord admins provide the destination Discord channel ids.
5. Operators add the channel mappings JSON and restart the bot.

## FAQ: Can We Reuse One Team Member's Credentials?

Technically, yes, for very basic delegated-access scenarios. In that model the bot acts on behalf of a real user instead of using app-only service credentials.

That is not the recommended setup for this module.

Main downsides:

- Reliability:
  - the integration breaks if that user changes password, loses access, leaves the company, or is affected by MFA or Conditional Access changes
- Security:
  - the bot now depends on a human credential or long-lived delegated refresh token, which is a worse secret to protect than a service credential
- Auditability:
  - reads and writes are attributed to a person rather than a service identity
- Access control:
  - the effective scope becomes whatever that user can access, which is often broader and less explicit than a dedicated app registration
- Operability:
  - Microsoft discourages username/password automation flows such as ROPC, and those flows are incompatible with common MFA-based tenant setups

Use a real Entra app registration with app-only auth for the poller.

If you later need a user-driven trigger that should feel native inside Teams, use a proper Teams app or message action flow instead of storing one employee's credentials in the bot.

## Native Teams Bot Replies

If you later need true bot replies inside Teams threads, you will need more than this module currently ships:

1. A Teams app manifest with bot scope for teams/channels.
2. A Bot Framework or Teams AI endpoint reachable from Microsoft over HTTPS.
3. Bot authentication and token validation for incoming activities.
4. Channel installation in each target team/channel.

That is a separate step because it changes the runtime shape from “poller” to “internet-facing bot service”.

## Microsoft References

- Receive all channel messages for bots and agents:
  https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-for-bots-and-agents
- Channel and group chat conversations with a bot:
  https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations
- Resource-specific consent:
  https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent
- Teams app permissions and consent:
  https://learn.microsoft.com/en-us/microsoftteams/app-permissions
- Apps for shared and private channels:
  https://learn.microsoft.com/en-us/microsoftteams/platform/build-apps-for-shared-private-channels
- Microsoft Graph permissions reference:
  https://learn.microsoft.com/en-us/graph/permissions-reference
