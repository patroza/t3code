# Discord bot browser automation

Status: proposed

## Summary

The Discord bot should run a browser automation host alongside its existing T3 WebSocket client. The host connects to the existing `PreviewAutomationBroker`, so coding agents continue to use the same `preview_*` MCP tools whether a request is served by Electron or by the bot.

The bot uses named Playwright persistent contexts. An operator creates or refreshes a profile in headed mode, completes interactive login, and closes the browser. Normal bot operation then opens the same profile directory in headless mode. A persistent context is preferred over cookie-only `storageState` because authentication commonly depends on local storage, IndexedDB, service workers, and browser-managed state in addition to cookies.

## Goals

- Make the existing preview automation tools available to Discord-originated turns without requiring a desktop client to remain open.
- Support a small set of operator-created login profiles that can be reused by headless browser sessions.
- Keep browser credentials local to the bot host and out of prompts, Discord messages, T3 protocol payloads, and logs.
- Preserve the existing preview automation contract and broker as the agent-facing API.
- Fail predictably when a profile is busy, expired, missing, or cannot start.

## Non-goals

- Synchronizing browser profiles between machines.
- Automating CAPTCHA, passkeys, hardware-backed WebAuthn, or anti-bot challenges.
- Allowing agents to create, export, or inspect profile credentials.
- Matching desktop-only viewport overlays and recordings in the first implementation.
- Running unbounded concurrent browsers or sharing one profile directory between processes.

## Existing architecture

Preview automation is already a host protocol rather than a direct MCP-to-Electron call:

```text
provider tool call
      |
      v
PreviewAutomationBroker (server)
      |
      +---- desktop host (Electron preview)
      |
      `---- Discord browser host (Playwright)
```

The shared contracts define host registration, request streaming, and responses. The broker assigns a provider session to an available host and keeps tab affinity. The web application currently registers an Electron-backed host. The Discord bot can register another host over its existing authenticated WebSocket connection.

The first implementation should not add a parallel Discord-specific automation protocol. It should implement the existing operations and return the existing error envelope.

## Profile model

A browser profile is a directory owned by the bot operating-system user:

```text
${T3_DISCORD_BOT_DATA_DIR}/browser/
  profiles.json
  profiles/
    github-default/
      user-data/
    google-work/
      user-data/
  locks/
```

`profiles.json` contains non-secret metadata only:

- Stable profile name.
- Creation and last verification timestamps.
- Optional verification URL and expected URL pattern.
- Browser executable identity and Playwright version.
- Operator description and allowed origin patterns.

The `user-data` directory is the credential. It must be mode `0700`, excluded from backups unless encrypted, and never uploaded as an artifact. Profile names are validated as conservative slugs and are the only profile input accepted from configuration.

### Why persistent contexts

Playwright `storageState` captures cookies and selected web storage, but it is not a complete browser profile. Persistent contexts also retain IndexedDB, service workers, cache-backed authentication data, and browser settings. They therefore give the best chance that a headed login remains valid when reopened headlessly.

Persistent profiles are not portable sessions. A site can still invalidate a session because the IP address, browser build, client certificate, device attestation, passkey, or risk score changed. Setup and runtime must use the same browser executable and should run on the same host.

## Operator workflow

### Create or refresh a profile

```bash
vp run --filter @t3tools/discord-bot browser-profile setup github-default \
  --url https://github.com/login \
  --verify-url https://github.com/settings/profile \
  --expect-url 'https://github.com/settings/**'
```

The command:

1. Acquires the profile lock.
2. Starts a headed persistent context with the profile's `user-data` directory.
3. Navigates to the setup URL and waits for the operator to finish login.
4. On Enter or browser close, navigates to the optional verification URL.
5. Checks the expected URL pattern, records non-secret metadata, and closes cleanly.

The command must not infer success merely because cookies exist. Without an explicit verification rule it records the profile as unverified and warns the operator.

### Verify without changing the profile

```bash
vp run --filter @t3tools/discord-bot browser-profile verify github-default
```

Verification opens the persistent context headlessly, visits the configured verification URL, and checks the expected URL pattern. A failed check reports that headed setup must be rerun; it does not delete the profile.

### Run the bot

```bash
T3_DISCORD_BROWSER_ENABLED=true \
T3_DISCORD_BROWSER_PROFILE=github-default \
T3_DISCORD_BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome \
vp run --filter @t3tools/discord-bot start
```

The initial implementation uses one configured default profile. Named per-project or per-channel profile selection can be added later, but the selected name must always come from trusted bot configuration rather than agent text.

## Host lifecycle

The browser host starts after the bot has established its T3 WebSocket session:

1. Validate the configured profile and browser executable.
2. Acquire an exclusive profile lock.
3. Launch one headless persistent context.
4. Register a stable host client ID and supported operations with `previewAutomationConnect`.
5. Process streamed requests and answer through `previewAutomationRespond`.
6. On disconnect, cancel outstanding work, close the context, release the lock, and reconnect with the bot session.

Tabs are keyed by the contract `PreviewTabId`. The host keeps an in-memory map from tab ID to Playwright page. `open` creates or reuses a page, and subsequent operations use broker tab affinity. Browser state persists across host restarts, while open tab identity does not. The host retains at most four pages per thread and twelve pages across the process, closing least-recently-used pages when either limit is exceeded. Pages with in-flight operations and the active recording page are protected from eviction; temporary overflow is reconciled when an operation completes.

The host advertises only operations it implements. The first slice supports status, open, navigate, snapshot, click, type, press, scroll, evaluate, and wait-for. Resize and recording remain desktop-only until they have host-neutral semantics.

## Routing and profile selection

The current broker prefers a focused compatible host and otherwise chooses an available host. That is sufficient when the bot is the only connected host. It is not enough for deterministic multi-host deployments because focus is a UI concept, not an execution policy.

A later contract revision should add host capabilities such as `kind: desktop | bot | worker` and an optional trusted profile label, then let invocation context express a host preference. Until then:

- The bot registers only for its own server environment.
- Operators should avoid connecting a desktop automation host to the same unattended bot environment when deterministic routing matters.
- The bot never exposes raw profile paths or accepts a profile name from an automation request.

## Concurrency and isolation

Only one browser process may use a persistent profile directory at a time. The host and profile CLI use the same exclusive lock. A lock records PID and start time for diagnostics, but existence alone is not treated as proof that the owner is alive. Stale-lock recovery must verify process liveness before removal.

The first implementation protects pages with in-flight operations and caps retained tabs. Later worker isolation can place each profile in a separate child process or microVM while retaining the same broker protocol.

For multiple identities, create multiple named profiles. Do not log several identities into one browser profile: cookies, account choosers, and cross-origin storage make selection ambiguous and increase accidental privilege crossover.

## Security policy

- Treat profile directories as long-lived credentials and restrict filesystem permissions.
- Run the browser and bot as an unprivileged dedicated user.
- Configure an origin allowlist per profile before enabling production automation.
- Reject `file:`, `data:`, browser-internal, and other non-HTTP(S) navigation.
- Redact URL query strings and fragments from logs by default.
- Never include cookies, storage values, page HTML, or evaluated secrets in logs.
- Bound evaluation output, snapshot size, operation time, active pages, and browser memory.
- Capture diagnostic screenshots only when explicitly enabled; screenshots can contain secrets.
- Keep Discord authorization and project authorization unchanged. Browser access adds capability and must not broaden who can trigger bot turns.

## Failure behavior

| Condition                | Behavior                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------ |
| Profile is missing       | Host does not register; startup reports the setup command.                           |
| Profile lock is held     | Host does not start a second browser; reports lock owner diagnostics.                |
| Login verification fails | Request returns a stable session-expired error and points operators to headed setup. |
| Browser crashes          | In-flight requests fail, context closes, and the host restarts with bounded backoff. |
| T3 connection drops      | Browser closes, lock releases, and host registration follows T3 reconnection.        |
| Operation times out      | The operation is cancelled without destroying unrelated tabs.                        |
| Result exceeds limits    | The host returns the existing result-too-large error envelope.                       |

The first contract may encode profile-specific failures as `PreviewAutomationExecutionError` with a safe operator-facing message. A dedicated `PreviewAutomationProfileUnavailableError` can be added once both server and clients need structured recovery UI.

## Delivery plan

### Phase 1: persistent profile and core host

- Add Playwright persistent-context profile setup, verify, list, and clear commands.
- Add bot configuration for enablement, default profile, executable path, limits, and optional verification.
- Register a bot automation host on the existing WebSocket session.
- Implement the core navigation and interaction operations.
- Add tests for profile validation, metadata, locking, URL policy, operation dispatch, and reconnect cleanup.
- Document deployment prerequisites and the headed-to-headless workflow.

### Phase 2: deterministic routing and policy

- Extend host metadata with host kind and profile capability labels.
- Add trusted per-project or per-channel profile selection.
- Add origin allowlists and policy-denial error types to shared contracts.
- Add operator-visible host/profile health without exposing secrets.

### Phase 3: isolation and parity

- Move browsers into supervised worker processes or microVMs.
- Add resource quotas and crash-loop protection.
- Define host-neutral resize, screenshot artifact, and recording behavior.
- Add encrypted profile backup/restore only if an operational requirement justifies the risk.

## Alternatives considered

### Export only `storageState`

This is easy to inspect and copy but omits browser-managed state used by many modern login flows. It remains useful for disposable test accounts, not as the primary operator workflow.

### Keep a headed desktop client connected

This already works through the broker but is operationally fragile for an unattended Discord bot. Desktop sleep, UI lifecycle, and focus also make routing unpredictable.

### Remote browser service first

A remote Playwright/CDP service improves isolation and scaling, but introduces credential transport, another availability dependency, and more deployment work. The in-process host establishes the protocol and profile model first; it can later move behind the same interface.

## Acceptance criteria for the first implementation

- An operator can log into a site in a headed browser and close it.
- A separate headless verification process reuses the same authenticated profile.
- The running Discord bot registers as a preview automation host and handles core `preview_*` calls.
- Concurrent processes cannot open the same profile.
- Missing, locked, and expired profiles produce actionable errors without leaking credentials.
- Bot shutdown or WebSocket disconnect closes the browser and releases its lock.
