# Microsoft Teams message action

Status: implemented.

The Teams app manifest declares **Start T3 investigation** as an action command in the `message`
context. `TeamsNativeApp` handles:

- `composeExtension/fetchTask` by returning an Adaptive Card dialog;
- project alias and optional instruction input;
- `composeExtension/submitAction` by starting a transport-neutral T3 turn;
- a private Teams confirmation without installing the conversational bot in the source
  conversation.

The action uses the selected Teams message as the investigation prompt and keys deduplication by
tenant plus source-message ID. It deliberately does not attempt to post a later result into a
conversation where the bot is not installed; users follow the T3 thread in T3 Code.

See [Deploying the T3 Code Microsoft Teams integration](./microsoft-teams-discord-bot.md) for
registration, packaging, installation, and rollout steps.
