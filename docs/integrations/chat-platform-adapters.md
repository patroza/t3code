# Chat Platform Adapters: Teams first, Slack optional

**Status:** plan
**Branch context:** `fork/discord`
**Scope:** support Microsoft Teams as a first-class alternative to Discord, and make Slack a low-friction follow-up adapter.

## Summary

T3 Code already has most of the hard logic for a chat bridge:

- T3 session bootstrap and orchestration dispatch
- thread link persistence
- turn lifecycle handling
- approval / stop controls
- stream vs finalize behavior
- attachment recovery and reposting

What is still tightly coupled to Discord is the transport and conversation model:

- bot mention parsing
- channel topic project binding
- Discord thread ids and thread titles
- Discord message edit and multipart upload semantics
- Discord component ids and ephemeral interaction replies

The implementation plan is to extract a platform-neutral bridge core, keep Discord as the reference adapter, then add Teams on top of the new boundary. Slack should follow only after the adapter contract is proven by Teams.

## Why Teams first

Teams is the better forcing function for the abstraction:

- it breaks more Discord-specific assumptions than Slack does
- it has stronger enterprise distribution value
- it adds product surfaces Discord does not have, especially message extensions and richer Microsoft 365 placement

If the adapter design can support Teams cleanly, Slack should be comparatively straightforward.

## Goals

1. Preserve current Discord behavior while extracting reusable bridge logic.
2. Add a Teams adapter that supports the core Discord-bot workflow:
   - start a task from chat
   - continue a linked conversation
   - approve / deny / stop
   - stream progress reasonably
   - post final answers with files and images
3. Make Slack a follow-up adapter with minimal additional core refactoring.
4. Replace Discord-only conversation binding assumptions with a platform-neutral binding model.

## Non-goals

- Perfectly identical UX across Discord, Teams, and Slack.
- Meeting, voice, or shared-channel-first experiences.
- Full Teams message extension and Slack slash-command feature sets in the first adapter PR.
- Server-side multi-platform schema changes unrelated to the bridge.

## Current repo shape

The current Discord integration is already close to the right split:

- transport and platform behavior live mostly under `apps/discord-bot/src/{discord,features,presentation}`
- T3 orchestration is centralized in `apps/discord-bot/src/t3/T3Session.ts`
- durable thread linkage is isolated in `apps/discord-bot/src/store/ThreadLinkStore.ts`
- `docs/integrations/discord-bot.md` already notes that T3 bridge services should stay reusable for a future Slack adapter

The missing step is a formal adapter boundary.

## Proposed architecture

```text
platform event
  -> platform adapter
  -> bridge core
  -> T3 session
  -> bridge core
  -> platform adapter
  -> platform message / file / card update
```

### Bridge core

Owns:

- T3 session connection and reconnect policy
- project resolution and conversation binding flow
- linked conversation persistence
- turn coordination and interrupt safety
- assistant stream state
- finalization rules
- approval state mapping
- attachment normalization between platform input and T3 upload payloads

Does not own:

- raw webhook / gateway handling
- platform mention syntax
- channel, thread, reply, or chat ids
- platform-specific message rendering primitives
- card or button payload formats

### Adapter boundary

Introduce a `ChatPlatformAdapter` interface with these responsibilities:

- normalize inbound events into a shared `PlatformTurnInput`
- expose platform capabilities
- render shared bridge actions into platform-native message operations
- persist enough platform identifiers to resume and finalize correctly

Suggested capability flags:

- `supportsEditableMessages`
- `supportsThreadReplies`
- `supportsButtons`
- `supportsEphemeralReplies`
- `supportsPinnedInfoMessage`
- `supportsConversationRename`
- `supportsUserImageUploads`
- `supportsFileUploads`
- `supportsPersonalChat`

Suggested shared operations:

- `postWorkingMessage`
- `updateWorkingMessage`
- `postFinalMessages`
- `deleteMessages`
- `postApprovalRequest`
- `acknowledgeInteraction`
- `postInfoMessage`
- `resolveConversationBinding`

## Binding model changes

Discord currently uses channel topics with `t3-<shortName>`. That does not generalize.

Replace this with two durable stores:

### `ProjectBindingStore`

Maps a platform conversation to a T3 project or workspace root.

Examples:

- Discord channel id -> workspace root
- Teams channel or chat id -> workspace root
- Slack channel id -> workspace root

### `ConversationLinkStore`

Maps a platform conversation thread to a T3 thread.

Examples:

- Discord thread id -> T3 thread id
- Teams parent message or reply chain id -> T3 thread id
- Slack `channel + thread_ts` -> T3 thread id

The current `ThreadLinkStore` can evolve into the second store, but the name and schema should become platform-neutral.

## Phased implementation plan

### PR 1: extract the bridge core and preserve Discord parity

Deliverables:

- create a reusable bridge core package or shared module
- move Discord-only logic behind an adapter
- keep the current Discord app behavior unchanged
- convert `ThreadLinkStore` into a platform-neutral link schema or wrap it with a neutral interface
- add capability-driven rendering paths where Discord currently assumes editable tips, topic binding, and component ids

Success criteria:

- existing Discord flows still work
- no user-visible Discord behavior regression
- tests still cover stream, finalize, approvals, stop, attachments, and reconnect paths

### PR 2: Teams adapter MVP

Deliverables:

- new Teams bridge app or adapter package
- channel and chat entrypoints
- linked conversation continuation
- approval / deny / stop actions via Adaptive Cards or equivalent invoke actions
- final answer posting with file and image support where platform support is practical
- project binding flow that does not depend on channel topic metadata

Recommended MVP surfaces:

- channel conversations
- standard replies to a parent message
- personal chat if it is easy once the bot is wired

Defer:

- message extensions
- tabs
- meeting surfaces
- shared channels

### PR 3: Slack adapter MVP

Deliverables:

- mention-based start and continue flow in channels
- threaded continuation using `thread_ts`
- approval / deny / stop controls with Block Kit buttons
- final answer and file/image posting
- optional slash command bootstrap outside threads

Defer:

- modals
- App Home
- complex admin or distribution flows

### PR 4: platform-specific enhancements

Possible follow-up work:

- Teams message extensions for “create task”, “search/share result”, or “investigate here”
- Teams personal-chat-first workflow
- Slack slash command improvements
- richer per-platform info/help surfaces
- conversation restore and resume improvements across all adapters

## Feature parity overview

| Capability                                              | Discord today | Teams target                                | Slack target |
| ------------------------------------------------------- | ------------- | ------------------------------------------- | ------------ |
| Start from mention in shared conversation               | Yes           | Yes                                         | Yes          |
| Continue linked conversation in reply/thread context    | Yes           | Yes                                         | Yes          |
| Streaming progress into the conversation                | Strong        | Good enough, likely less polished           | Strong       |
| Approve / deny controls                                 | Yes           | Yes                                         | Yes          |
| Stop active turn                                        | Yes           | Yes                                         | Yes          |
| Final answer split across multiple platform messages    | Yes           | Yes                                         | Yes          |
| Attach images and local files on finalize               | Yes           | Partial-to-strong                           | Strong       |
| Accept user image attachments as turn input             | Yes           | Yes, with platform-specific attachment work | Yes          |
| Project binding without server-side project duplication | Yes           | Yes                                         | Yes          |
| Conversation restore after reconnect/restart            | Planned       | Planned                                     | Planned      |
| Mirror T3 thread title back to platform                 | Yes           | Optional                                    | Optional     |
| Pinned channel help / setup surface                     | Yes           | Optional                                    | Optional     |
| Ops alert channel                                       | Yes           | Yes                                         | Yes          |

## What each platform uniquely adds

### Discord

Strengths:

- best current streaming UX for this repo
- easy project binding via channel topic
- public threads map well to T3 linked conversations
- simple component interaction model

Weaknesses:

- weaker enterprise deployment fit
- less compelling for Microsoft-centric organizations

### Teams

Strengths:

- strong enterprise distribution inside Microsoft 365
- can operate in personal chat, group chat, and channel scopes
- message extensions are a meaningful future differentiator
- Adaptive Cards provide a richer structured UI surface than plain chat messages

Weaknesses:

- more constrained formatting and card behavior
- more client inconsistency than the abstraction should ignore
- less natural fit for Discord-style live “edit the tip message” streaming

### Slack

Strengths:

- native thread model maps cleanly to the current T3 conversation design
- Block Kit provides strong button and layout support
- slash commands are useful as an explicit bootstrap path outside threads

Weaknesses:

- fewer unique product advantages than Teams for this repo's next step
- distributed app rate-limit constraints can matter for some install models

## Platform constraints that should shape implementation

### Teams

- Microsoft documents bot scope support across personal chat, group chat, and channels.
- Teams message posting supports chats, channels, and channel replies.
- Teams shared channels currently do not support bots, connectors, or message extensions.
- Teams Adaptive Cards support is narrower than the generic Bot Framework surface suggests, especially across client versions and mobile.

Implication:

Do not design the bridge around shared channels, advanced card features, or Discord-style message editing assumptions.

### Slack

- Slack threads map cleanly to `channel + thread_ts`.
- Slack slash commands cannot be invoked inside message threads.
- Slack file upload flows should use the current upload approach documented by Slack rather than old deprecated patterns.
- Slack changed `conversations.history` and `conversations.replies` rate limits on May 29, 2025 for new non-Marketplace commercially distributed apps and new installs of existing distributed apps. Slack explicitly says internal customer-built apps are not impacted.

Implication:

Prefer event-driven linked-thread continuation and avoid designs that require high-volume thread-history polling.

## Recommended repo changes

### Structure

One reasonable shape:

```text
apps/chat-bridge-core/
apps/discord-bot/
apps/teams-bot/
apps/slack-bot/
```

Alternative:

```text
packages/chat-bridge-core/
apps/discord-bot/
apps/teams-bot/
apps/slack-bot/
```

Use whichever layout best fits the monorepo's current package boundaries. The important part is that platform-neutral runtime logic should not continue living only inside `apps/discord-bot`.

### Shared modules to extract first

- conversation link store
- turn coordinator
- bridge state machine
- finalization policy
- approval state rendering model
- attachment normalization and T3 upload translation
- shared prompt/bootstrap policy for first-turn context

### Discord-specific modules that should remain adapter-local

- mention parsing
- role mention ambiguity handling
- channel topic parsing
- Discord component ids
- Discord multipart file upload details
- thread rename and pin behaviors

## Risks

1. The first refactor may accidentally encode Discord assumptions in the “shared” core if the adapter boundary is defined too late.
2. Teams may tempt over-investment in rich cards before the basic reply-linked workflow is stable.
3. Slack can look easy because its threads map cleanly, but distribution and rate-limit assumptions need to stay explicit.
4. If project binding is not made neutral early, every adapter will invent its own local configuration path.

## Recommendation for the initial implementation PR

The first code PR after this plan should be the abstraction PR, not the Teams adapter.

That PR should:

- extract the bridge core
- keep Discord fully functional
- convert storage and rendering boundaries to platform-neutral interfaces
- leave the repo in a state where a Teams adapter can be added without reworking the Discord app again

## Related work already in this branch

- **Teams Graph intake module** (ported from aaaomega/t3code-pvt#1):
  `apps/discord-bot/src/features/TeamsModule.ts`,
  `docs/integrations/microsoft-teams-discord-bot.md`
- **Teams message-action plan** (ported from aaaomega/t3code-pvt#6):
  `docs/integrations/microsoft-teams-message-action-plan.md`
- Shared start/continue helper for Discord + Teams intake:
  `apps/discord-bot/src/features/LinkedTurnRouter.ts`

The intake module is a near-term path that escalates Teams traffic into Discord/T3 without waiting for a full Bot Framework adapter. The message-action plan covers the preferred long-term low-noise trigger model. Both feed into the phased adapter extraction above.

## References

- Current Discord integration: `docs/integrations/discord-bot.md`
- Teams intake module: `docs/integrations/microsoft-teams-discord-bot.md`
- Teams message actions plan: `docs/integrations/microsoft-teams-message-action-plan.md`
- Current Discord router: `apps/discord-bot/src/features/MentionRouter.ts`
- Current bridge implementation: `apps/discord-bot/src/features/ResponseBridge.ts`
- Current T3 transport layer: `apps/discord-bot/src/t3/T3Session.ts`

External platform references used for this plan:

- Slack slash commands: <https://docs.slack.dev/interactivity/implementing-slash-commands/>
- Slack thread replies: <https://docs.slack.dev/messaging/sending-and-scheduling-messages/>
- Slack thread retrieval and limits: <https://docs.slack.dev/reference/methods/conversations.replies/>
- Slack file uploads: <https://docs.slack.dev/messaging/working-with-files/>
- Slack rate-limit changes dated May 29, 2025: <https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/>
- Teams bots overview: <https://learn.microsoft.com/en-us/microsoftteams/platform/bots/overview>
- Teams message extensions: <https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/what-are-messaging-extensions>
- Teams message posting: <https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0>
- Teams cards reference: <https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-reference>
- Teams card actions: <https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-actions>
- Teams limits: <https://learn.microsoft.com/en-us/microsoftteams/limits-specifications-teams>
