# Deploying the T3 Code Microsoft Teams integration

T3 Code supports Microsoft Teams in two independent operating modes:

1. **Teams replacement mode** runs a native Teams app and does not require Discord credentials or
   a Discord gateway connection. Teams messages start or continue T3 threads; final answers return
   to Teams.
2. **Intake-only mode** starts T3 from a selected Teams message without adding the bot to that
   conversation. The bot-based message action invokes the service, returns a private confirmation,
   and leaves the T3 thread available in T3 Code.

The legacy Graph poller is still available for automatic assessment, allowlisted reactions, and
tag triggers. Its per-channel `deliveryMode` can be `discord`, `t3-only`, or `native`.

## Runtime capabilities

| Capability                           | Teams replacement                            | Message action          | Graph poller                              |
| ------------------------------------ | -------------------------------------------- | ----------------------- | ----------------------------------------- |
| Start/continue a T3 thread           | Yes                                          | Yes                     | Yes                                       |
| Discord required                     | No                                           | No                      | Only for `deliveryMode: "discord"`        |
| Bot installed in target conversation | Yes                                          | No                      | No                                        |
| Final answer posted to Teams         | Yes                                          | No; follow in T3 Code   | Optional workflow webhook acknowledgement |
| Stop a turn                          | `stop`                                       | In T3 Code              | In T3 Code                                |
| Approve/deny                         | `approve <request-id>` / `deny <request-id>` | In T3 Code              | In T3 Code                                |
| Answer requested input               | `answer <request-id> {"id":"answer"}`        | In T3 Code              | In T3 Code                                |
| Automatic/reaction/tag triggers      | Optional Graph poller                        | Explicit message action | Yes                                       |

Microsoft requires a Teams app to be installed in a team or group chat before its bot can send
messages there. A message extension can be invoked from a message without making the bot a
participant in that conversation; that path intentionally does not attempt a later bot reply.

## 1. Prepare T3 Code

1. Run the T3 Code server and note its HTTP origin.
2. Add every project that Teams may target to T3 Code.
3. Create the same project alias file used by the Discord bridge:

   ```yaml
   projects:
     scanner:
       workspaceRoot: /srv/projects/scanner
   ```

4. Set:

   ```dotenv
   T3_HTTP_BASE_URL=http://127.0.0.1:3773
   T3_PROJECT_ALIASES_PATH=/etc/t3/project-aliases.yaml
   T3_WEB_UI_BASE_URL=https://t3.example.com
   T3_DISCORD_BOT_DATA_DIR=/var/lib/t3/teams-bridge
   ```

`T3_DISCORD_BOT_DATA_DIR` retains its historical name but is also the durable data directory for
Teams-only deployments.

## 2. Register the Microsoft application

The fastest supported path is the current Teams Developer CLI:

```bash
npm install --global @microsoft/teams.cli
teams login
teams app create \
  --name t3-code \
  --endpoint https://teams-bot.example.com/api/messages \
  --env /secure/path/teams.env
```

The public endpoint must use HTTPS and route to the bridge process on `TEAMS_PORT` (3978 by
default). The CLI creates the application/bot registration and writes the client, tenant, and
secret values. An equivalent Azure Bot + Entra app registration created in the portals also works.

Set the runtime variables using the values from the registration:

```dotenv
TEAMS_NATIVE_ENABLED=1
TEAMS_CLIENT_ID=00000000-0000-0000-0000-000000000000
TEAMS_CLIENT_SECRET=replace-with-secret-value
TEAMS_TENANT_ID=00000000-0000-0000-0000-000000000000
TEAMS_PORT=3978
TEAMS_MESSAGING_ENDPOINT=/api/messages
TEAMS_DEFAULT_PROJECT_SHORT_NAME=scanner
```

Do not set `DISCORD_BOT_TOKEN` in a Teams-only deployment.

## 3. Configure project mapping by Teams channel

Copy `apps/discord-bot/teams.channels.example.json` and map Teams locations to T3 aliases:

```json
{
  "channels": [
    {
      "teamId": "19:team-id@thread.tacv2",
      "channelId": "19:channel-id@thread.tacv2",
      "channelName": "Production incidents",
      "projectShortName": "scanner",
      "deliveryMode": "native",
      "company": "Example",
      "environment": "production",
      "companyKeywords": ["example"],
      "environmentKeywords": ["prod", "production"],
      "automaticAssessmentEnabled": false
    }
  ]
}
```

Set `TEAMS_CHANNELS_PATH` to that file. Personal and group chats use
`TEAMS_DEFAULT_PROJECT_SHORT_NAME` when no channel mapping matches.

Delivery modes:

- `native`: native Teams activity handling owns replies. The Graph poller may still supply
  background triggers, but it does not create Discord threads.
- `t3-only`: Graph triggers start T3 directly and optionally acknowledge through
  `teamsIncomingWebhookUrl`.
- `discord`: compatibility mode; `discordChannelId` is required and the result is mirrored to
  Discord.

## 4. Build the Teams app package

Start from `apps/discord-bot/teams-app/manifest.json`.

1. Replace `${TEAMS_APP_ID}` and `${TEAMS_CLIENT_ID}` with the application/client ID.
2. Replace `${PUBLIC_BASE_URL}` and `${PUBLIC_HOST}` with the public HTTPS origin and host.
3. Add `outline.png` (32×32 transparent) and `color.png` (192×192).
4. Zip the three files at the archive root:

   ```text
   manifest.json
   outline.png
   color.png
   ```

The manifest enables personal, team, and group-chat bot scopes plus the
**Start T3 investigation** message action.

## 5. Install for full Teams replacement

1. Upload the app package through **Teams Admin Center → Teams apps → Manage apps**, or sideload it
   while testing.
2. Allow the app in the applicable app permission policy.
3. Install it for users and in each team/group chat where it must answer.
4. In a channel, mention the bot and send a task. In personal chat, send the task directly.
5. Verify that Teams receives a “Started T3” acknowledgement and then the final T3 answer.
6. Verify controls:

   ```text
   stop
   approve <request-id>
   deny <request-id>
   answer <request-id> {"question-id":"answer"}
   ```

The native entrypoint is:

```bash
pnpm --filter @t3tools/discord-bot start:teams
```

For a systemd/container deployment, expose only `TEAMS_PORT` through the HTTPS reverse proxy and
keep the T3 server/data paths private.

## 6. Enable the message action without bot participation

The same app package includes a bot-based message extension. The app must be available to the user,
but the conversational bot does not have to be added to the source channel/chat.

1. Make the app available through an app setup policy or let the user add the app personally.
2. Open the **…** menu on a Teams message.
3. Choose **Start T3 investigation**.
4. Select the T3 project alias and optionally add instructions.
5. Submit. Teams shows a private confirmation while the service starts the T3 thread.
6. Follow the result in T3 Code.

This route is appropriate where adding an active bot participant to customer or incident channels
is not yet approved.

## 7. Optional Graph polling without a bot participant

Set `TEAMS_ENABLED=1` in a combined deployment and grant the Entra application the chosen Graph
read permission. Prefer resource-specific consent (`ChannelMessage.Read.Group`) when monitoring a
small set of teams; broader application permissions require tenant admin consent and a wider
security review.

The poller supports:

- automatic problem-report assessment;
- allowlisted reaction triggers;
- allowlisted tag triggers;
- explicit configured display-name mentions;
- recent history and hosted image retrieval.

Use `deliveryMode: "t3-only"` to ensure the poller never creates or requires a Discord thread.

## 8. Production checklist

- Public HTTPS endpoint resolves to `TEAMS_MESSAGING_ENDPOINT`.
- Inbound activity authentication is enabled; never set SDK `skipAuth` in production.
- Client secret is stored in a secret manager and rotated, or replace it with managed identity.
- `T3_PROJECT_ALIASES_PATH` contains every exposed alias and no unintended workspace.
- Teams app policies limit who can install/use the app.
- Graph permissions use the narrowest viable consent model.
- Durable bridge data is backed up.
- T3 and Teams bridge logs/OTLP traces are monitored.
- A test message verifies start, continuation, final delivery, stop, approval, and message action.
- Discord is disabled by omitting `DISCORD_BOT_TOKEN` when Teams is the sole transport.

## Microsoft references

- [Teams SDK quickstart and app registration](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/get-started/quickstart-register)
- [Teams bot conversations](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/build-conversational-capability)
- [Proactive message installation requirements](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
- [Message-extension action dialogs](https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/how-to/action-commands/create-task-module)
- [Resource-specific consent](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Receive channel/chat messages using RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-for-bots-and-agents)
