# Microsoft Teams Message Action Plan

This document describes the next step after the polling-based Teams intake module: a native Teams message action that lets an internal user trigger investigation from the message UI instead of relying on visible channel tags.

It is intended to stack on top of the polling implementation in [`docs/integrations/microsoft-teams-discord-bot.md`](/var/lib/t3/worktrees/t3code/t3-discord-87fc50be/docs/integrations/microsoft-teams-discord-bot.md).

## Why This Mode

The current poller already supports three low-friction triggers:

- automatic German problem detection
- allowlisted internal-user reactions
- allowlisted internal-user tag messages

Those are good short-term options, but a native Teams message action is a better end state because it:

- avoids noisy visible tags in the channel
- keeps the trigger close to the source message
- makes authorization easier to explain to internal users
- gives us room for a confirmation dialog before opening a Discord/T3 investigation

## Recommended Product Shape

Use a bot-based Teams message extension with an action command available in the `message` context.

Recommended command name:

- `Start investigation`

Optional second command later:

- `Start investigation with note`

Why bot-based:

- Teams action commands for message actions are supported through bot-based message extensions.
- This keeps us compatible with the existing bot-style workflow and gives us room for richer dialog handling later.

## User Flow

1. An internal user opens the message action menu on a Teams message.
2. The user selects `Start investigation`.
3. Phase 1 can immediately submit the message payload without a form.
4. The bot service validates the user and channel against our allowlists.
5. The service resolves the source message, recent history, and image attachments.
6. The existing Teams-to-Discord intake pipeline is invoked with reason `message-action`.
7. Teams returns a lightweight confirmation to the triggering user.
8. Discord receives or reuses the linked thread and starts the T3 investigation.

## Architecture

Add a small internet-facing Teams bot service next to the current poller.

Core pieces:

- Teams app manifest with:
  - `bot`
  - `composeExtensions`
  - action command in `message` context
- Microsoft Bot registration with Teams channel enabled
- HTTPS endpoint that receives Bot Framework invoke activities for the message extension
- shared intake service that both the poller and the message action path call

Recommended internal split:

- Keep Graph polling in the current module.
- Extract intake orchestration into a shared service, for example `TeamsIntakeRouter`.
- Let both:
  - the poller
  - the message action webhook
    call the same `start investigation` path.

That avoids duplicating:

- Discord thread lookup/creation
- attachment copying
- history collection
- dedupe rules
- T3 turn startup

## Auth And Permissions

### Teams App / Bot

Required:

- Microsoft Entra app registration for the Teams app/bot identity
- Bot Framework registration
- Teams channel enabled for the bot
- public HTTPS endpoint with Bot Framework auth/token validation

### Graph Access

The message action payload gives message context, but the service should still fetch canonical message data through Microsoft Graph before escalation so that it can:

- pull image attachments and hosted content
- collect recent history
- apply channel configuration and dedupe rules consistently

This means the message action path still depends on Graph application permissions or resource-specific consent, the same way the poller does.

### Allowlisting

The server should enforce all of these before starting an investigation:

- triggering Teams user id is allowlisted for that channel
- target Teams channel is configured
- source message root has not already been processed

## Organizational Approval

Compared with the current poller-only setup, the message action path adds a second approval surface:

1. Security review for the Entra app registration and Graph permissions.
2. Teams admin review for the app manifest, bot capability, and message extension capability.
3. Bot service review because the app now exposes a public HTTPS endpoint.
4. Team-owner rollout approval for installation into the specific teams/channels.

Operationally, the main extra review item is that this is no longer just a background poller. It becomes an interactive Teams app with an externally reachable bot endpoint.

## Proposed Delivery Phases

### Phase 1

Goal: single-click message action without extra dialog fields.

Scope:

- one `Start investigation` message action
- allowlisted users only
- channel allowlist only
- reuse existing Discord/T3 intake behavior
- ephemeral confirmation back to Teams

### Phase 2

Goal: optional operator note.

Scope:

- task module or dialog with one optional text field
- note is added to the T3 prompt and Discord seed

### Phase 3

Goal: operational hardening.

Scope:

- audit logging for who triggered what
- clearer Teams-side confirmation including Discord thread link if feasible
- retry and idempotency handling for duplicate invoke deliveries

## Implementation Plan

1. Extract the current Teams escalation logic from `TeamsModule` into a reusable service.
2. Extend the intake reason model to include `message-action`.
3. Add a minimal Teams app manifest package in the repo for admin review.
4. Add a bot webhook route that validates Bot Framework requests.
5. Parse the message action invoke payload and map it to:
   - Teams user id
   - team id
   - channel id
   - target message id
6. Fetch the canonical message plus recent history and hosted contents through Graph.
7. Reuse the shared intake router to create or continue the Discord/T3 investigation.
8. Return a simple success/failure response to Teams.
9. Document deployment, app upload, admin approval, and per-channel enablement.

## Open Questions

- Do we want the message action to be installed tenant-wide but only enabled by config, or only installed into selected teams?
- Should message action be limited to root messages, or allowed on replies as well?
- Do we want the confirmation response to include a Discord link, or keep it minimal?
- Should message action use the same dedupe key as reactions and auto-detection, or intentionally allow a forced retrigger option later?

## Microsoft References

- Build message extensions:
  https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/what-are-messaging-extensions
- Build bot-based message extensions:
  https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/build-bot-based-message-extension
- Define action commands:
  https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/how-to/action-commands/define-action-command
- Teams SDK action commands guide:
  https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/in-depth-guides/message-extensions/action-commands
