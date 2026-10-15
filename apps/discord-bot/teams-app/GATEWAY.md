# Shared Teams bot

Install the gateway package into each participating team using the same bot and app
identity. The host gateway selects a T3 workspace from an explicit tenant/team/channel
binding; it never selects a workspace from a person’s membership or a default project.

Mention the bot to start/continue work or send `stop`, `approve`, `deny` and `answer`
commands. Adding the mention in an edit also starts work if that message has not
already triggered a request. Later edits do not rerun an accepted request. Without a mention, an authorized person’s message is context only. The
context is quoted as untrusted data, bounded by count/TTL, kept only in memory, and
never invokes T3. Personal/group chats and message actions are disabled in this package.

The reusable gateway starts with `pnpm --filter @t3tools/discord-bot start:teams-gateway`.
Supply `TEAMS_GATEWAY_CONFIG` (JSON), `TEAMS_GATEWAY_BOT_SECRET_FILE` (owner-only raw
client-secret file), and `TEAMS_GATEWAY_STATE_DIR` (private directory). Use separate
owner-only bearer files and state directories for each workspace. The JSON contract
is defined in `src/teams/gatewayConfig.ts`; bindings include exact tenant, team, channel,
project alias/ID, and authorized Entra actor IDs. Workspace fields are `enabled`,
`webOrigin`, `t3HttpBaseUrl`, `credentialFile`, `dataDir`, `projectAliasesPath`, and
`identityMapPath`; optional model/provider/base-branch defaults belong to each workspace.

Only POST `/api/messages` is exposed, on loopback, with SDK JWT verification and
bounded JSON input. Place the existing bot callback proxy in front of that listener.
Outgoing messages stay on the host and retain the authenticated conversation reference.
T3 sees authenticated orchestration requests, not the global bot credential.

Runtime routing/actor changes are reread on intake and delivery; connection, identity,
credential or state changes require restart. An uninstall persistently revokes its
team; reinstall does not silently authorize it. An operator must review and remove the
corresponding revocation from stopped gateway state before reactivation. Existing
Teams links can be imported into each workspace’s `links.json`; preserve their source
keys and verify project IDs. Duplicate receipts are durable and work is at most once:
a crash after admission may require a new mention, never an automatic work retry.

Generate the RSC package from `gateway-manifest.json` only for the gateway release.
The ordinary `manifest.json` remains mention-only for legacy single-instance bots.
The team owner must accept the new channel-reading permission during app upgrade.
Tenant consent/distribution policy may require administrator involvement. RSC grants
team-wide message delivery; channel and actor restrictions are enforced by the gateway.
The initial implementation supports commercial Teams service URLs, no attachment
processing or history backfill, and bounded queues of 20 mentions per workspace.

## Channel description tags

The app requests `ChannelSettings.Read.Group` so the gateway can read descriptions in the
installed team. Enable `useChannelDescription` on an already authorized channel binding and
set `descriptionProjectShortNames` to its approved project aliases (including its default).
This feature is off by default; existing configurations do not make new Graph metadata requests.

Descriptions use the same parsers as Discord channel topics:

```text
omegent-link-example-project
omegent-default-model-grok-4.7
omegent-fast-mode
```

`omegent-ips` explicitly opts into progress-history files. Without a project tag the configured
project is retained; unapproved or malformed link tags reject dispatch. Defaults affect new
conversations only; continuing a thread keeps its model and cannot change its project. Start a
new Teams conversation after changing the project tag. Metadata is cached for 30 seconds, scoped
by tenant/team/channel, and failed reads are not cached or silently replaced with default settings.

Native Teams channels support the same two settings in `TEAMS_CHANNELS_PATH`. Updating the app
package must consent to the team-scoped channel-settings permission before enabling descriptions.
No description tag changes tenant, workspace, actor authorization or file-upload permissions.
