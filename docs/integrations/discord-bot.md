# T3 Discord Bot

Headless Effect + [dfx](https://github.com/tim-smart/dfx) client that bridges Discord project channels to T3 Code threads (with optional git worktrees).

## Prerequisites

1. A running T3 Code server with projects registered for the workspace roots you care about.
2. A Discord bot application with **Message Content Intent** enabled, invited to your guild with permissions to read messages, send messages, and create public threads.
3. A **bot-local** project aliases file (`T3_PROJECT_ALIASES_PATH`). The T3 server does not need to know about Discord short names.

## Project aliases (bot only)

Create a YAML or JSON file for the Discord bot process:

```yaml
example-project: ~/projects/example-project
t3-code: /home/you/pj/t3code
```

```bash
export T3_PROJECT_ALIASES_PATH=~/.t3/discord-bot/project-aliases.yaml
```

The bot resolves channel topics → shortName → workspace path, then finds the matching T3 project in the server shell snapshot by `workspaceRoot`.

## Optional per-process alert rules

Guest ops alerts can also use a dedicated YAML or JSON file for process-specific
RSS / CPU / sustained-duration ceilings:

```bash
export T3_DISCORD_ALERT_PROCESS_RULES_PATH=~/.t3/discord-bot/alert-process-rules.yaml
```

Example:

```yaml
rules:
  - id: jaeger-linux
    match: jaeger-linux
    rss: 4gb
    duration: 5m
```

Rules match case-insensitive substrings against the full process command line
and the shortened label shown in Discord alerts. `rss` is interpreted in MiB
units (`4gb` => `4096` MiB). `cpu` is percent of a single core averaged across
poll windows.

## Channel binding

Set the Discord channel **topic** to include:

```text
t3-example-project
```

## Run the bot

```bash
cd apps/discord-bot
# from monorepo root: pnpm install

export DISCORD_BOT_TOKEN=...
export T3_HTTP_BASE_URL=http://127.0.0.1:3773
export T3_PROJECT_ALIASES_PATH=~/.t3/discord-bot/project-aliases.yaml
export T3_DISCORD_ALERT_PROCESS_RULES_PATH=~/.t3/discord-bot/alert-process-rules.yaml

# Pair once and reuse a token, or bootstrap:
export T3_BOOTSTRAP_CREDENTIAL=...   # from local-bootstrap-credential / pairing
# optional (defaults match T3 web: codex + gpt-5.4)
export T3_DEFAULT_INSTANCE_ID=codex
export T3_DEFAULT_MODEL=gpt-5.4
export T3_DEFAULT_BASE_BRANCH=main
export T3_DISCORD_BOT_DATA_DIR=~/.t3/discord-bot
export T3_WEB_UI_BASE_URL=http://127.0.0.1:5173
# optional Jira browse base for pinned thread-info issue links (e.g. https://your-org.atlassian.net)
# export T3_JIRA_BROWSE_BASE_URL=https://example.atlassian.net
# optional Honeycomb deep-link template for Sentry bootstrap (placeholders: {traceId} {environment} {dataset} {team})
# export T3_HONEYCOMB_TRACE_URL_TEMPLATE='https://ui.honeycomb.io/TEAM/environments/{environment}/trace?trace_id={traceId}'
# pin Cursor Composer when desired:
# export T3_DEFAULT_INSTANCE_ID=cursor
# export T3_DEFAULT_MODEL=composer-2

pnpm --filter @t3tools/discord-bot start
```

## Browser automation

The bot can register a headless Playwright host for the same `preview_*` tools used by the desktop app. Create a named persistent profile in a headed browser first:

```bash
export T3_DISCORD_BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome

pnpm --filter @t3tools/discord-bot browser-profile setup github-default \
  --url https://github.com/login \
  --verify-url https://github.com/settings/profile \
  --expect-url 'https://github.com/settings/**'

pnpm --filter @t3tools/discord-bot browser-profile verify github-default
```

After completing login and verification, enable the host:

```bash
export T3_DISCORD_BROWSER_ENABLED=true
export T3_DISCORD_BROWSER_PROFILE=github-default
export T3_DISCORD_BROWSER_ALLOWED_ORIGINS='https://github.com,https://*.github.com'
# optional; defaults to ffmpeg on PATH
export T3_DISCORD_BROWSER_FFMPEG_PATH=/usr/bin/ffmpeg
pnpm --filter @t3tools/discord-bot start
```

Setup and runtime must use the same browser executable on the same host. Profile directories under `T3_DISCORD_BOT_DATA_DIR/browser` contain credentials; restrict them to the bot user and do not upload or commit them. Use `browser-profile list`, `verify`, or `clear <name> --yes` for profile maintenance.

The headless host supports status, open, navigation, PNG snapshots, click, type, key press, scroll, evaluation, wait-for, and MP4 recording. Video capture requires `ffmpeg`; unfinished frame directories are cleaned on shutdown. Desktop-specific resize remains unavailable. See [the architecture design](../architecture/discord-browser-automation.md) for security, routing, and later isolation work.

## First pull into an existing Discord thread

When the bot is first linked into a Discord thread, it loads the **thread starter** and combines it with the `@mention`:

- **Sentry-related** starter/mention/referenced message (e.g. `sentry.io` URL or author/body containing “Sentry”): full investigation bootstrap (issue parse → Sentry tools → Honeycomb link first, then the user request)
- **Otherwise**: short starter context + user request only (no Sentry/Honeycomb token burn)
- In both cases, the bootstrap instructs the agent to lead with the answer, stay concise, and avoid padded recap unless extra detail is useful.

### Referenced / reply-to messages

When you **reply to** another Discord message while addressing the bot (or thread-talk sends a reply), the bot resolves that target via gateway `referenced_message` or REST `message_reference` and injects it into the agent prompt:

- Author, content, embeds (e.g. Sentry alert fields), and a Discord jump link
- On **every** turn (first link and continuations), not only the thread starter
- If the referenced message looks like Sentry, first-turn bootstrap prefers it as primary incident context

This is the preferred way to point the bot at an alert or earlier message—prefer reply over pasting a screenshot. On-demand MCP fetch of arbitrary Discord messages is not implemented yet; only the message you reply to is included automatically.

Every turn, including continuations, also tells the agent that it is responding as the Discord bot
to the same thread. The prompt identifies the current requester by Discord user ID, username,
and display name (server nickname first, then global display name), so references such as “you” and
participant attribution remain clear even after a long conversation or context compaction.

## Discord message streaming

During a turn the bot:

1. **In progress:** edits its latest message while it remains the channel tip (opens a new tip if someone posts after it, or when text exceeds 2000 characters). Every 10 seconds, the same tracked tip cycles `_Working.._`, `_Working..._`, and `_Working...._` as a liveness heartbeat; when the current turn has tool activity it also shows a collapsed count (e.g. `_Working.. · 3 tool calls_`) — not individual tool rows. It never creates heartbeat messages. Local markdown image paths are hidden during the stream.
2. **On completion:**
   - Posts the **final answer as normal Discord message content** (split across multiple messages if over 2000 characters)
   - Archives the in-progress stream as an attached `stream-history.md` on the **same createMessage** as the last chunk when it has intermediate progress beyond the final answer (skipped when the tip body is empty or equals the final message; Discord cannot add attachments via edit)
   - Deletes **all** live stream messages (including displaced tips) so only the final answer stays in the channel
3. **Images:** always uploaded on `createMessage` with multipart files (never via `updateMessage`):
   - T3 chat image attachments (`message.attachments`) via `assets.createUrl`
   - Local markdown embeds such as `![alt](attachment:/var/lib/t3/.codex/generated_images/…png)` (scheme stripped) via disk or assets, then real Discord file attachments
4. **Linked local files:** markdown links to local files such as `[table.csv](/tmp/table.csv)` are stripped from the final text and uploaded as real Discord attachments on the final `createMessage`

### Architecture: client-aligned state, Discord-only projection

Other T3 clients (web/mobile) keep a live `OrchestrationThread` via
`client-runtime` `EnvironmentThreadState` and **render** it. Discord cannot share
that React/Atom stack without forking core, so the bot:

| Layer                                                | Where                                                                             | Aligned with clients?                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Event apply + sequence cursor + HTTP reload          | `DiscordThreadFollower` + `applyThreadDetailEvent` from `@t3tools/client-runtime` | **Yes** — same reducer, same seed/resume/reload semantics                   |
| Durable resubscribe on transport death               | `followOrchestrationThread` (retry forever + HTTP catch-up)                       | **Yes** — same intent as client `subscribe(..., retryExpectedFailureAfter)` |
| Discord tips / finalize / 2k limits / stream-history | `ResponseBridge` + `DiscordDelivery`                                              | **Discord-only** — surface projector, not a second source of truth          |

So: **source of truth remains the orchestration thread** (same as other clients). The bot only owns _how_ that state is mirrored onto Discord’s message API.

### Delivery reliability

The T3 web client and Discord are different _presentation_ paths. The client paints thread state; Discord projects it through ResponseBridge.

To keep Discord responsive when the orchestration WS stream stalls or Discord REST is slow:

1. **Coalescing delivery queue** — WS events only publish the latest snapshot. A single worker serializes Discord I/O so a hung `createMessage` cannot block the subscription fiber from receiving later assistant bubbles. Each snapshot applies **stream tip / finalize first**, then title/pin/tasks — mid-turn thread renames and PR lookups must not starve live `_Working.._` tip edits. Live **Tasks** messages are bot-owned and do **not** freeze/reopen the stream tip (only human replies do). Discord **system** messages (channel renames, pins) also do not displace the tip. New threads start Working+bridge **before** the info pin so the agent is not racing an empty tip. Secondary work is time-capped; if `processThreadSnapshot` still times out, the bridge **auto-recovers** (backoff → HTTP reseed → retry) instead of staying stuck until the next WS event.
   1b. **Finalize accept-without-ack** — finals are create-based (not tip edits). On retry, the bridge scans recent bot messages for already-posted final chunks and **adopts** those ids instead of creating duplicates; durable `lastFinalizedAssistantId` is written as soon as the first final chunk lands.
2. **HTTP reconcile (every ~12s)** while Working tips are open, a turn is running, or a Discord-originated turn has not finalized yet — re-fetches `/api/orchestration/threads/:id` and re-applies the snapshot so stuck `_Working.._` tips still resolve to the final answer.
3. **Finalize timeouts** — Discord create/fallback paths for final posts are bounded (~45s) with a text-only fallback so a stuck multipart upload cannot pin the bridge forever.
4. **Boot/reconnect catch-up** — links with open stream tip ids are rehydrated and force-finalize completed turns that finished while the bot was offline.
5. **Mid-turn restart** — in-progress `_Working.._` tips are **not** deleted when the bridge fiber stops during a running turn; rehydrate resumes/edits them (or recreates if Discord already deleted the message). Empty progress still seeds a Working tip so Discord never goes dark while T3 is busy.
6. **Delivery epoch FSM** (`DiscordDelivery.ts`) — each new user Working ack starts a monotonic **epoch** with phases `awaiting → streaming → finalized`. After `finalized`, the **same** assistant is a hard no-op (no final+Working mess), but a **later** assistant after `lastFinalizedAssistantId` (or same-id text growth past `lastFinalizedText`) reopens stream/finalize. **Settle grace** requires two idle snapshots before finalize so multi-step status lines cannot lock the epoch. Assistant selection drops assistants at/before `lastFinalizedAssistantId` in message order — even while `turnInProgress`.
7. **New-thread Working ack + stream timeouts** — new Discord threads post `_Working.._` before the bridge starts (same as continue). Stream tip Discord I/O is time-capped so a hung REST call cannot freeze the delivery queue while T3 keeps advancing.
8. **Subscription auto-retry** — `subscribeThread` no longer dies on a single WS failure; the bridge resubscribes with exponential backoff and HTTP-seeds missed snapshots so deploy restarts / transient drops do not leave Discord on permanent `_Working.._`.
9. **Dual delivery cursor** — `lastThreadSnapshotSequence` advances when T3 state is observed (fast WS resume via `afterSequence`); `lastDeliveredSequence` advances only after Discord delivery succeeds. When delivery lags orchestration, HTTP reconcile and boot rehydrate keep catching up even if stream tips look clean.
10. **Storage / memory efficiency** — link markers stay O(1) (sequences, tip ids, last finalized). A **trimmed warm cache** (`$dataDir/thread-cache/<threadId>.json`) stores the reduced tip (messages after last finalize minus buffer of 2) + `snapshotSequence`, like web/desktop thread cache. Resume prefers warm base + `afterSequence` (delta catch-up) over full HTTP tip; HTTP is fallback when warm is missing.

Auth: prefer `T3_BEARER_TOKEN` (long-lived) or `T3_BOOTSTRAP_CREDENTIAL` with `deviceType: bot`. Scopes need `orchestration:read` and `orchestration:operate`.

## Usage

Prefer **`/t3`** slash commands (shown first on the channel info pin). `@bot` mentions remain a full fallback.

| Action                                            | Result                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/t3 ask prompt:fix the flaky test`               | Creates a Discord thread + T3 thread with a new worktree off `main`                              |
| `/t3 ask prompt:also check CI` in a linked thread | Continues the same T3 thread                                                                     |
| `/t3 thread-talk action:on` in a linked thread    | Lets human messages start turns without a mention until `thread-talk` off                        |
| `/t3 thread-talk action:status`                   | Reports whether mention-free thread-talk is enabled                                              |
| `/t3 link ref:<id\|t3-url>`                       | Pick up an existing T3 thread: create Discord thread if needed, or jump to it                    |
| `@bot` + **image attachment(s)**                  | Downloads Discord images and sends them as T3 chat image attachments (max 8)                     |
| Slash options / mention flags                     | `model` `provider` `base` `local` `plan` · or `--model` `--provider` `--base` `--local` `--plan` |

### Native slash commands (preferred; `@bot` still works)

Guild-scoped `/t3` commands (fast to register for a single-server bot). Mentions remain fully supported.

| Slash command                            | Result                                                                                         | Ack visibility                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `/t3 ask prompt:…`                       | Start or continue a turn (optional `model` `provider` `base` `local` `plan`)                   | **Public** prompt ack; work continues via normal bridge |
| `/t3 help`                               | Points at the channel info pin                                                                 | Ephemeral                                               |
| `/t3 stop`                               | Stops the active turn in a linked thread                                                       | **Public** on success; ephemeral if nothing to stop     |
| `/t3 thread-talk action:on\|off\|status` | Same as `@bot thread-talk …`                                                                   | Public for on/off; ephemeral for status                 |
| `/t3 link ref:<id\|t3-url>`              | Same as `@bot link …`                                                                          | Public                                                  |
| `/t3 refresh-indicators`                 | Force-refresh Discord thread title badges (PR/VCS: ▫️/🔀/✔️/…); also `@bot refresh-indicators` | Ephemeral (title change is visible on the thread)       |
| `/omegent assign` / `/agent assign`      | Assign linked PR(s) on this thread to **you** (identity map). Optional `github:<login>`        | **Public** summary after deferred gh call               |
| `/omegent assign github:login`           | Same, but assign the given GitHub username (with or without `@`)                               | **Public** summary after deferred gh call               |

### Agent PR policy (Discord turns)

Every Discord turn injects conversation meta that requires agents to **always open a GitHub PR** for work that produces commits (or is clearly intended to land). Draft PRs are preferred until full lint / typecheck / tests / `vp check` finish; convert to ready only after those gates. See `AGENTS.md` → _Discord-originated pull requests_ and the identity-map attribution block (rule 6).

**Visibility policy (neutral default):** shared-state mutations and agent work get **public** acks so the channel remains auditable. Personal/read-only signals (`help`, `thread-talk status`, benign “nothing to stop”) stay **ephemeral**. No role gates yet — any member in a project channel may use these.

**Later tweak options:** ephemeral stop success; quiet mode (ephemeral ask ack + thread-only work); role-restricted `link` / `stop`; global command registration if multi-guild.

After bot restart, guild command registration may take a few seconds (dfx bulk-sets guild commands on sync).

**Link an existing T3 thread** (no new T3 conversation, no new turn):

- Only from a **project channel**, or from a **Discord thread that is not yet linked** to any T3 thread. Not supported inside an already-linked Discord thread.
- Accepts a bare thread id or a T3 web URL containing `?thread=` / `&thread=` (aliases: `pick-up`, `pickup`).
- If that T3 thread is already linked to a Discord thread, the bot replies with a jump link to it.
- If not, it creates a Discord thread from the mention (or uses the current unlinked Discord thread) and stores the durable Discord↔T3 link, then bridges like a normal linked thread.
- The channel (or parent channel) project topic must match the T3 thread’s project when present.

Approvals: Allow / Deny buttons when the agent requests approval.

Thread links persist under `T3_DISCORD_BOT_DATA_DIR/links.json`.

Each linked Discord thread gets a **pinned thread-info message** (`T3 Thread Info`) with:

- Model / worktree / Open in T3
- When the model changes, the Model line auto-updates and notes when it changed, e.g.
  `Model: \`grok/grok-4.5\` (since 2026-07-20 at 10:05, started with \`codex/gpt-5.4\`)`
- An ordered, de-duplicated list of **Jira issue links** observed in messages to the bot (and
  thread history). Keys are first-seen order; bare keys become browse links when
  `T3_JIRA_BROWSE_BASE_URL` (or `JIRA_BROWSE_BASE_URL`) is set.
  The same durable keys are **re-injected into every Discord-originated agent turn** as a
  “Linked work items” block (with PR guidance) so later turns still see tickets that only
  appeared earlier in the thread.
- An ordered, de-duplicated list of **GitHub PR links** (`https://github.com/…/pull/N`)
  observed in messages and thread history under a **PRs** section next to Jira. Same-repo
  PRs render as `[PR #N](url)`; cross-repo PRs include the slug
  (`[owner/repo PR #N](url)`), comparing against the channel project / worktree remote.

The pin is created on first link, refreshed when new Jira keys or PR URLs appear or the model
changes (including mid-bridge shell updates), and **backfilled on bot start** for active links
(scan recent history + re-pin).

Thread-talk is opt-in per linked Discord thread and defaults to off. While T3 is already
working, mention-free messages are not submitted; the bot replies with instructions to wait or
stop the active turn. Mention-free turns post only their final response: no Working marker,
in-progress stream archive, or task-progress message. Mentioned prompts retain the full progress
behavior. Task progress always edits the thread's one persisted task message across turns.

**Restore after bot restart / T3 reconnect** (implemented): on boot (and again after the T3
WebSocket reconnects), the bot rehydrates bridges for threads that are still **running**,
**pending approval/user-input**, or have stored **open stream tip ids** (catch-up finalize for
turns that finished while the bot was down). Idle completed links stay lazy until the next
`@mention`. Concurrent bridges are capped at 50 (freshest `lastActivityAt` wins). Catch-up
finalize only deletes stored stream tip ids — it never scans the channel for orphan Working
markers. Design notes:
[`apps/discord-bot/DESIGN-thread-restore.md`](../../apps/discord-bot/DESIGN-thread-restore.md).

**Guest restart / Discord-before-T3 race** (implemented): the Discord gateway can come READY
before the guest T3 process is listening. Boot uses `connectUntilReady` (same backoff as
mid-life reconnect) and does **not** exit the process when T3 is late. Connect is only
considered successful once the orchestration **shell snapshot** has arrived (so project
lookups are not empty). Mid-life drops still tear down + reconnect; transport errors on
dispatch also force reconnect when `RpcSession.closed` is slow/missed. Mentions that land
while T3 is reconnecting get a transient “still connecting… try again” reply instead of a
false “no T3 project registered at this path” error.

## Architecture notes

- Project shortName mapping lives **only on the Discord bot** — not in T3 server config/DB.
- T3 mutations use WebSocket `orchestration.dispatchCommand` (required for worktree bootstrap).
- Discord I/O is isolated under `apps/discord-bot/src/{discord,features}`; T3 bridge services stay reusable for a future Slack adapter.
