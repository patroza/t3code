# Provider Usage and Remaining Quota Stats

Status: **planning** (branch `t3code/provider-usage-stats`)

## Goal

Add a **provider-neutral usage surface** that displays session, weekly, and monthly consumption or remaining allowance for configured provider instances that expose quota data — without blocking chat startup or degrading provider reliability.

Users should be able to see current usage and remaining quota for each configured provider instance when the provider supports it, and use a **cross-provider overview** to decide which agent to use (Codex vs Claude vs Cursor Composer 2.5 vs OpenCode, etc.).

The overview should answer, at a glance:

1. **Can I use this provider right now?** (auth, install, rate-limit state)
2. **How much of my allowance is left?** (rolling windows, credits, spend caps)
3. **What did I consume recently?** (per-thread context window + account-level totals where available)
4. **Which model is the best tradeoff for this task?** (Composer 2.5 fast vs standard, Codex effort tiers, Claude model tiers, etc.)

### Design rules (non-negotiable)

- **Quota information is advisory.** It must never be required to start a session, send a turn, list models, or render the composer.
- **Tolerate missing, stale, or partially supported data.** Render whatever is known; label unknown values explicitly.
- **Provider windows are provider-defined**, not T3-defined. Use provider-specific window keys (e.g. `rolling-5h`) with human display labels.
- **Do not convert credits to tokens** or invent windows a provider does not expose.
- **Multi-instance isolation:** multiple instances of the same driver do not share cached usage snapshots.

This is a **decision dashboard**, not a billing system. We normalize what each provider exposes; we do not replace provider consoles or invoices.

---

## Current integration points

| Area | Existing shape | Planned change |
| --- | --- | --- |
| Contracts | `ServerProvider` carries status, auth, models, skills, update state, version advisory | Add optional `usage?: ProviderUsageSnapshot` on provider snapshots |
| Server provider runtime | Each `ProviderDriver` materializes per-instance snapshot, adapter, textGeneration | Add optional `usage?: ProviderUsageReader` with `readUsage({ force?: boolean })` |
| Config stream | `subscribeServerConfig` pushes provider status to web | Include cached quota snapshots so UI updates passively |
| WebSocket RPC | Provider refresh, config methods | Add `providers.refreshUsage` for user-triggered refresh |
| Thread runtime | `thread.token-usage.updated` → `context-window.updated` activity | Keep `ContextWindowMeter` for per-thread context; add account-level quota separately |
| Codex reference | `packages/effect-codex-app-server` maps `account/usage/read` + `account/rateLimits/read` | Use as typed read reference; do not force other providers into Codex's daily-token schema |

### What already exists in code

| Layer | Location | Notes |
| --- | --- | --- |
| Thread usage contract | `packages/contracts/src/providerRuntime.ts` → `ThreadTokenUsageSnapshot` | Rich per-thread fields |
| Account rate-limit event | same → `account.rate-limits.updated` | Payload is `Schema.Unknown` |
| Codex adapter | `apps/server/src/provider/Layers/CodexAdapter.ts` | Token usage + rate-limit **push** events |
| Claude adapter | `apps/server/src/provider/Layers/ClaudeAdapter.ts` | SDK usage + `rate_limit_event` push |
| Ingestion → activity | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` | `context-window.updated` activities |
| Per-thread UI | `apps/web/src/components/chat/ContextWindowMeter.tsx` | Composer context ring |
| Provider settings | `apps/web/src/routes/settings.providers.tsx` | No usage summary yet |
| Codex RPC schemas | `packages/effect-codex-app-server` | Read RPCs generated but **not called** from snapshot path |

---

## Quota contract

Add a provider-neutral schema in `packages/contracts/src/providerUsage.ts` (schema-only). Attach optionally to `ServerProvider` for backward compatibility.

```ts
ProviderUsageSnapshot {
  status: "supported" | "unsupported" | "unavailable";
  checkedAt: IsoDateTime;
  source: "provider-api" | "cli" | "local-cache" | "runtime-event";
  plan?: { label?: string; tier?: string };
  windows: ProviderUsageWindow[];
  message?: string;
}

ProviderUsageWindow {
  key: string;           // provider-defined: "rolling-5h", "weekly", "primary", "composer", …
  label: string;         // human display label
  used?: number;
  limit?: number;
  remaining?: number;
  unit: "tokens" | "credits" | "requests" | "usd" | "percent" | "unknown";
  resetsAt?: IsoDateTime;
  resetLabel?: string;   // e.g. "resets in 4h" when provider gives relative text only
}
```

Some providers expose only remaining quota, only usage, or only reset time. The UI renders whatever is known.

Optional aggregate for cross-provider overview page:

```ts
ProviderUsageOverview {
  checkedAt: IsoDateTime;
  instances: ReadonlyArray<{
    instanceId: ProviderInstanceId;
    driver: ProviderDriverKind;
    usage: ProviderUsageSnapshot;
  }>;
}
```

Mapping rules:

- **`Schema.Unknown` provider payloads stay at adapter boundary** — readers map into windows; contracts never import Codex/Claude/Cursor types.
- Validate all usage schemas at WebSocket transport boundaries.

---

## Resolved provider matrix

Legend for telemetry today:

- **Live** — already emitted/consumed in T3 Code
- **Planned** — specified in this doc, not implemented
- **None** — no known machine-readable surface

| Provider | Verified quota source | Window semantics | Plan status | T3 telemetry today |
| --- | --- | --- | --- | --- |
| **Codex** | `account/rateLimits/read` + push; `account/usage/read` for stats | Primary (≈5h), secondary (weekly), credits/spend controls | ChatGPT Plus/Pro/Team via `planType` | **Live** push; **Planned** pull |
| **Claude** | `/usage` (human); status-line `rate_limits` JSON (machine-readable, active session) | Session + weekly (+ model-specific pools); monthly is spend/credits, not subscription quota | Claude Pro/Max/Team | **Live** `rate_limit_event` push; **Planned** status-line snapshots |
| **Cursor** | ACP extension TBD; Composer usage pool in Cursor app | Composer pool (individual plans); metered per-token (Teams) | Composer 2.5 Fast/Standard tiers | **None** |
| **OpenCode Go** | OpenCode console workspace billing (not local SDK) | Rolling 5h ($12), weekly ($30), monthly ($60) — USD | Needs console auth | **None** |
| **OpenCode Z.ai** | No public balance/quota read endpoint | Error 1113 only | GLM Coding Plan | **None** (error-derived fallback) |
| **Grok** | xAI ACP extensions TBD | BYOK / upstream | xAI API | **None** |
| **OpenCode (other BYOK)** | Upstream API key limits | Provider-dependent | User-configured | **None** |

### Cursor / Composer 2.5

Cursor is first-class in T3 Code but absent from quota telemetry. Treat Composer 2.5 as a distinct economic choice in the matrix:

| Composer variant | ACP model id (expected) | List pricing (per 1M tokens) | Billing bucket |
| --- | --- | --- | --- |
| **Composer 2.5 Fast** (product default) | `composer-2.5` or `composer-2.5[fast=true]` | $3.00 in / $15.00 out | Individual: Composer usage pool; Teams: metered |
| **Composer 2.5 Standard** | `composer-2.5[fast=false]` | $0.50 in / $2.50 out | Same |
| Composer 2 (legacy T3 default) | `composer-2` | Superseded | Migrate defaults to 2.5 |

T3 gaps: defaults still `composer-2` in `packages/contracts/src/model.ts`; no usage events from `CursorAdapter`; no Composer pool read via CLI/ACP yet.

References: [Composer 2.5 docs](https://cursor.com/docs/models/cursor-composer-2-5), [Cursor ACP extensions](https://cursor.com/docs/cli/acp#cursor-extension-methods)

### Open questions resolved enough for direction

| Question | Answer | Decision |
| --- | --- | --- |
| Does Claude expose stable quota APIs? | `/usage` for humans; status-line `rate_limits` for machine-readable active-session data | Cached **active-session** snapshots only; **no background `/usage` turns** |
| Does OpenCode expose quota via local server API? | Public local SDK has no documented quota read; Go usage computed in OpenCode console | Add contract now; defer live Go reader until console auth or official endpoint |
| Z.ai balance/quota fields? | Docs cover coding-plan endpoints + error 1113; no read endpoint | Error-derived status only; mark `unsupported` for live remaining quota |
| Session windows — provider or T3 defined? | Provider-defined (Claude rolling pools; OpenCode Go 5h/weekly/monthly) | Use provider-specific window keys + display labels |
| API keys alone sufficient? | No for all providers | Claude needs active session; OpenCode Go needs console workspace; Z.ai has no read API |

---

## Server flow

```
Web UI (settings cards + composer + optional /settings/usage overview)
    ↕ WebSocket RPC (providers.refreshUsage) + config stream (passive updates)
Usage snapshot cache (per ProviderInstanceId — TTL, stale fallback, dedupe)
    ↕ optional ProviderUsageReader.readUsage({ force? })
Provider adapters / readers (Codex, Claude, Cursor, OpenCode Go, …)
    ↕ backoff + timeout (3–5s); never blocks provider status refresh
Upstream provider APIs / CLI / runtime events
```

### Provider reader capability

```ts
interface ProviderUsageReader {
  readUsage(input: { force?: boolean }): Effect<ProviderUsageSnapshot, ProviderUsageReadError>;
}
```

Wire as optional on provider instance or snapshot pipeline — implemented per driver without cross-provider coupling.

### Shared cache utility

Build in `packages/shared` or `apps/server/src/provider/`:

- TTL cache per `ProviderInstanceId` (~60s default)
- **3–5 second timeout** on reads
- Stale snapshot fallback when refresh fails or times out
- Concurrent refresh **dedupe** (one in-flight read per instance)
- Failure classification: `unsupported`, `unauthenticated`, `rate-limited`, `temporarily-unavailable`
- **Never blocks** provider status / readiness probes

### Provider reader requirements

- Use each instance's configured environment and home directory
- Do not read credentials from global process state unless the provider already does
- Never log API keys, bearer tokens, account IDs, or raw provider responses
- Expose unit and reset semantics exactly as reported

---

## Provider-specific readers

### Codex

| Source | Maps to window |
| --- | --- |
| `account/rateLimits/read`.rateLimits.primary | `primary` (≈5h) |
| `.secondary` | `weekly` |
| `.credits` | `credits` (USD) |
| `.planType` | `plan.label` |
| `account/usage/read`.summary | informational (not a limit window) |
| Push `account/rateLimits/updated` | merge if newer than poll |
| `thread/tokenUsage/updated` | per-thread context (separate from quota snapshot) |

Use `packages/effect-codex-app-server` typed schemas. Show `rateLimitsByLimitId` buckets when workspace member vs owner limits apply.

### Claude

Claude is an **active-session usage source**, not a background account polling source.

- Capture `rate_limits` from Claude Code **status-line JSON** when the adapter can observe it
- Also map **`rate_limit_event`** push payloads when present
- **Do not run `/usage` as a hidden background turn** — it is a session command and alters UX
- Expose **session + weekly** windows; do not invent a monthly subscription quota window
- For API-key or gateway sessions, prefer cost/usage telemetry over subscription quota fields
- Keep multiple Claude homes isolated per instance

Sources checked: Claude Code `/usage` command docs; error reference (session/weekly/model limits); status-line JSON for custom usage displays.

### Cursor

- Investigate Cursor CLI / ACP for usage or billing snapshot (extension method preferred)
- Until available: `status: "unsupported"` with message linking to Cursor Settings → Usage
- Static cost hints for Composer 2.5 Fast vs Standard in overview matrix
- Phase 2: migrate default model to `composer-2.5`; emit `thread.token-usage.updated` if ACP adds session usage

### OpenCode Go

OpenCode Go has concrete provider-defined windows: rolling 5-hour, weekly, and monthly limits in **USD**.

- Map `rollingUsage` → `rolling-5h` window (**not** a T3 session window)
- Use `unit: "usd"` or percentage display
- OpenCode local server SDK has **no documented public quota read method**
- **Only enable live Go usage when user has authenticated OpenCode console workspace access**

Sources checked: OpenCode Go docs (5h $12 / weekly $30 / monthly $60); upstream console `lite-section.tsx` + `subscription.ts` for percentage + `resetInSec`.

### OpenCode Z.ai

Start as **capability/error reporting**, not full quota display.

- Read Z.ai credentials from OpenCode provider env/config path
- Detect coding-plan config by base URL + models (GLM-5.2, GLM-5-Turbo, GLM-4.7)
- Surface error **1113** as "insufficient balance or no resource package"
- Do not show weekly/monthly Z.ai windows until Z.ai documents a read API
- Mark `status: "unsupported"` for live remaining quota

Sources checked: Z.ai FAQ + error docs (1113 documented; no quota read endpoint found).

### Grok

Check xAI ACP extensions; likely `unsupported` with BYOK message until API exists.

---

## UI plan

### Settings — provider instance cards (primary)

Add a **compact usage block** to each `ProviderInstanceCard`, below auth/status and above model overrides:

- Session / weekly / monthly (or provider-specific) rows
- Used / remaining when known; progress bars when limit is known
- Reset labels when available
- **Refresh icon button** with tooltip; disabled while in flight
- Fallbacks: "Usage unavailable", "Provider does not expose usage", "Last checked …" — never empty space

### Composer — active provider indicator

Show a **small quota indicator** for the selected provider when `usage.status === "supported"` and at least one window has data. Keep existing **`ContextWindowMeter`** for per-thread context window (orthogonal concern).

### Optional — cross-provider overview (`/settings/usage`)

Dedicated overview page or settings tab for comparing all instances side-by-side:

```
┌─────────────────────────────────────────────────────────────┐
│ Provider usage                         [Refresh all]        │
│ Updated 12s ago                                             │
├──────────┬──────────┬──────────┬──────────┬─────────────────┤
│ Codex    │ Claude   │ Cursor   │ Grok     │ OpenCode        │
│ ● ready  │ ● ready  │ ◐ warn   │ ○ off    │ ● ready         │
│ Primary  │ Session  │ Composer │ —        │ Go / Z.ai       │
│ ████░░   │ ███░░░   │ n/a      │ —        │ console req.    │
└──────────┴──────────┴──────────┴──────────┴─────────────────┘
```

Phase 3+: headroom score, cost hints, "suggested pick" for model/provider choice.

### Mobile (phase 4)

Read-only usage blocks on mobile Settings provider cards; reuse RPC + schemas.

---

## Implementation phases

### Phase 0 — Planning (this doc)

- [x] Merge cross-provider overview + provider-specific quota spec
- [x] Document matrix including Cursor Composer 2.5 + OpenCode Go/Z.ai split
- [ ] Confirm Cursor ACP usage extension availability

### Phase 1 — Contracts, cache, Codex + Claude

1. Add `ProviderUsageSnapshot` / `ProviderUsageWindow` schemas + tests in `packages/contracts`
2. Optional `usage?: ProviderUsageSnapshot` on `ServerProvider`
3. Shared TTL cache utility (timeout, stale fallback, dedupe, error taxonomy)
4. Optional `ProviderUsageReader` on instance pipeline
5. **Codex reader:** `account/rateLimits/read` + merge push events
6. **Claude reader:** status-line `rate_limits` + `rate_limit_event` mapping (active-session only)
7. Wire cached snapshots into config stream; add `providers.refreshUsage` RPC
8. Settings card usage block + composer quota indicator
9. Tests: contract encode/decode, reader unit tests, cache tests, RPC tests, React rendering tests

### Phase 2 — Cursor / Composer 2.5

1. Update model defaults + aliases to `composer-2.5`
2. Research + implement Cursor usage reader or documented `unsupported` fallback
3. Add Cursor row to overview with plan-aware copy

### Phase 3 — OpenCode Go, Z.ai, Grok, polish

1. **OpenCode Go** reader when console auth available
2. **Z.ai** config detection + error 1113 surfacing
3. **Grok** — ACP research
4. Optional `/settings/usage` overview page + suggestion helpers
5. Optional SQLite daily rollups for trends

### Phase 4 — Mobile

Read-only mirror of settings usage blocks.

---

## Testing plan

- Contract decode/encode: complete, partial, unsupported, and stale snapshots
- Provider reader unit tests with mocked CLI/HTTP responses per provider
- Cache: TTL, force refresh, stale fallback, timeout, concurrent dedupe
- WebSocket RPC: success, unsupported provider, authorization failures
- React: settings card rendering, composer indicator, refresh in-flight states
- Manual E2E with real provider accounts before enabling by default

---

## Acceptance criteria

- Providers **without** usage support behave exactly as they do today
- Supported instances show **last checked time** and at least one usage window (or explicit unsupported/unavailable)
- Failed usage refreshes do **not** change provider readiness unless the provider itself is broken
- Multiple instances of the same driver do **not** share cached snapshots
- All usage schemas validated at transport boundaries
- Cursor documented in matrix with Composer 2.5 economics and default migration path
- OpenCode Go vs Z.ai handled with distinct reader strategies
- Claude uses active-session status-line data; no hidden `/usage` polling
- `vp check` and `vp run typecheck` pass before implementation is considered complete

---

## Upstream issues and PRs (`pingdotgg/t3code`)

Surveyed 2026-07-04. Several upstream efforts overlap this plan; **PR #1732 is the primary implementation to align with or build on** rather than duplicating in parallel.

### Tracking issue

| Item | State | Relevance |
| --- | --- | --- |
| [#228 — feat: add usage / quota visibility for Codex sessions and accounts](https://github.com/pingdotgg/t3code/issues/228) | **Open** | Umbrella request: per-thread token usage, account rate limits/credits, lightweight UI summary, graceful degradation. Maintainer initially marked "not planned"; community interest remains high. [#673](https://github.com/pingdotgg/t3code/issues/673) was closed as duplicate of #228. |

### Active upstream PRs (highest priority)

| PR | State | Scope | Notes for this plan |
| --- | --- | --- | --- |
| [#1732 — feat: display provider usage limits in settings](https://github.com/pingdotgg/t3code/pull/1732) | **Open** (~4.5k LOC, 56 files) | End-to-end settings usage for **Codex, Claude, Cursor, OpenCode** | **Closest upstream match.** Adds `ServerProvider.usageLimits` (`ServerProviderUsageLimits` with `session`/`weekly` windows, `usedPercent`, `resetsAt`), `ProviderUsageState` service, per-driver probes (`codexUsageProbe`, `claudeUsageProbe`, `openCodeUsageLimits`, …), registry patch push, settings card UI. OpenCode: Go + Zen managed only. Cursor/Grok: explicit unavailable stubs until subscription read exists. Claims to fix #228. |
| [#3691 — feat(codex): add account rotation and quota management](https://github.com/pingdotgg/t3code/pull/3691) | **Open** (~2.6k LOC) | Codex multi-account + auto-rotation on rate limits | Adjacent, not a substitute for usage UI. Touches auth homes and persisted config on limit events — coordinate if both land. |

**PR #1732 schema vs this plan:** upstream uses `ServerProvider.usageLimits` with percent-based `session`/`weekly` windows; this plan proposes `ProviderUsageSnapshot` with richer `windows[]` (`used`/`limit`/`remaining`, multiple units). Before implementing locally, **diff against #1732** and either extend its contract or contribute missing pieces (Composer 2.5 cost matrix, Z.ai error path, `/settings/usage` overview) upstream.

**PR #1732 server modules to mirror:**

- `apps/server/src/provider/Layers/ProviderUsageState.ts`
- `apps/server/src/provider/codexUsageProbe.ts`, `claudeUsageProbe.ts`, `openCodeUsageLimits.ts`
- `apps/server/src/provider/providerUsageLimits.ts` (normalization + stale-merge rules)
- `packages/contracts/src/server.ts` → `ServerProviderUsageLimits`

### Closed PRs (superseded or maintenance-closed)

Maintainer [juliusmarminge](https://github.com/juliusmarminge) closed several usage PRs in a June 2026 sweep, citing overlap with **#1732** and existing `account.rate-limits.updated` events:

| PR | Title | Why closed / note |
| --- | --- | --- |
| [#2484](https://github.com/pingdotgg/t3code/pull/2484) | Add Codex usage indicator | Overlaps #1732; composer chip for Codex 5h + weekly |
| [#2193](https://github.com/pingdotgg/t3code/pull/2193) | Surface provider rate limit usage in composer | Wired `account.rate-limits.updated` → activities → composer tooltip (Codex + Claude) |
| [#2155](https://github.com/pingdotgg/t3code/pull/2155) | Account limit meter in composer | Codex-only composer meter |
| [#2033](https://github.com/pingdotgg/t3code/pull/2033) | Add rate limit display to UI | Branch toolbar rate-limit component |
| [#1605](https://github.com/pingdotgg/t3code/pull/1605) | Track provider usage and project weekly quota | Normalization + cache merge fixes for #228 |
| [#880](https://github.com/pingdotgg/t3code/pull/880) / [#669](https://github.com/pingdotgg/t3code/pull/669) | Weekly/session usage pill in sidebar | Sidebar Codex rate-limit pill + config stream |
| [#362](https://github.com/pingdotgg/t3code/pull/362) | Codex rate limit API in provider picker | Early `server.getCodexRateLimits` approach |
| [#2197](https://github.com/pingdotgg/t3code/pull/2197) | Refresh button on sidebar usage card | Reuses `server.refreshProviders()` |
| [#2201](https://github.com/pingdotgg/t3code/pull/2201) | Codex/sidebar usage refresh | Closed in same sweep |

Useful implementation ideas from closed PRs still worth preserving in this plan:

- Composer/footer indicator alongside settings ([ #2193](https://github.com/pingdotgg/t3code/pull/2193), [#2484](https://github.com/pingdotgg/t3code/pull/2484))
- Sidebar refresh without opening settings ([#2197](https://github.com/pingdotgg/t3code/pull/2197))
- Stale usage cache merge when newer snapshot omits usage ([#1605](https://github.com/pingdotgg/t3code/pull/1605))

### Related issues (bugs, adjacent features)

| Issue | State | Relevance |
| --- | --- | --- |
| [#2720 — Codex drains plan credits while idle](https://github.com/pingdotgg/t3code/issues/2720) | Open | **Usage refresh must not block chat and should avoid expensive idle polling.** Periodic `probeCodexAppServerProvider` / snapshot refresh may hit Codex APIs; align refresh cadence with #2720 mitigation. |
| [#2209 — OpenCode + Gemini no quota-exceeded signal](https://github.com/pingdotgg/t3code/issues/2209) | Closed | Consolidated into #228; supports error-derived / exhausted-account UX for OpenCode backends. |
| [#2518 — Compact per-turn session stats footer](https://github.com/pingdotgg/t3code/issues/2518) | Closed | **Complementary**, not duplicate: per-turn tok/sec/TTFT footer vs account quota. Uses same `ThreadTokenUsageSnapshot` pipeline. |
| [#2034 / #2551 — Claude context window meter normalization](https://github.com/pingdotgg/t3code/pull/2551) | Closed | Per-thread context meter fixes; orthogonal to account quota. |

### Alignment decisions for this worktree

1. **Prefer building on or porting #1732** before inventing a parallel `ProviderUsageSnapshot` contract — upstream already chose `ServerProvider.usageLimits` + `ProviderUsageState`.
2. **Cursor / Composer 2.5:** upstream #1732 stubs Cursor as unavailable (`source: "cursorAcp"`); this plan's Composer pool + pricing matrix is **still an gap** upstream.
3. **OpenCode Z.ai:** upstream #1732 covers Go/Zen managed paths; Z.ai error-1113 fallback from this plan is **not** evident in #1732 — keep as follow-up.
4. **Composer quota chip:** upstream trend is settings-first (#1732); composer indicators were closed as duplicate — decide whether to revive as thin client of `usageLimits` or stay settings-only.
5. **Cross-provider overview page (`/settings/usage`):** not in upstream PRs; remains a distinct addition if desired after #1732 lands.

---

## Wishlist: remote host CPU / memory / load visibility

Related to the provider usage dashboard: when you have **multiple environments** (local desktop, SSH box, WSL, relay-linked remote, future agentbox), you also need to know **whether the machine itself has headroom** — not just provider quota.

Today T3 can answer "which Codex account has quota left?" but not "is my remote dev box already at 95% RAM?"

### What exists today

| Surface | Scope | Metrics |
| --- | --- | --- |
| [`server.getProcessDiagnostics`](packages/contracts/src/rpc.ts) / [`ProcessDiagnostics`](apps/server/src/diagnostics/ProcessDiagnostics.ts) | **T3 process tree only** on the connected server | Per-process `cpuPercent`, `rssBytes`; totals for server subtree |
| [`server.getProcessResourceHistory`](packages/contracts/src/rpc.ts) / [`ProcessResourceMonitor`](apps/server/src/diagnostics/ProcessResourceMonitor.ts) | Same — sampled history for T3 processes | Bucketed CPU %, max RSS |
| Settings → Diagnostics UI | Local connected environment | Process table ([`DiagnosticsSettings.tsx`](apps/web/src/components/settings/DiagnosticsSettings.tsx)) |
| Connections / environment rows | All saved environments | **Connection phase only** (connected / connecting / error) — no host stats ([`ConnectionsSettings.tsx`](apps/web/src/components/settings/ConnectionsSettings.tsx)) |
| Mobile workspace status | Connected environments | Disconnected / reconnecting label only ([`WorkspaceConnectionStatus.tsx`](apps/mobile/src/features/home/WorkspaceConnectionStatus.tsx)) |

**Gap:** no **host-level** snapshot (system CPU %, memory used/total, load average) exposed per `ExecutionEnvironment`, and no compact % display on remote rows in Connections or the environment picker.

### Wishlist goal

For each **connected remote** (and optionally local), show at a glance:

- **CPU** — system-wide utilization % (or normalized per-core busy %)
- **Memory** — used / total % (and optionally available bytes)
- **Load** — 1/5/15-minute load average, normalized by core count where useful (e.g. load ÷ cores as a 0–100% pressure hint)

Same design rule as provider quota: **advisory only** — must not block connect, send turns, or environment switching.

### Suggested contract (sketch)

```ts
ServerHostResourceSnapshot {
  status: "supported" | "unsupported" | "unavailable";
  checkedAt: IsoDateTime;
  source: "os" | "procfs" | "wmi" | "unavailable";
  cpuPercent?: number;           // system-wide 0–100
  memoryUsedPercent?: number;    // 0–100
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  loadAverage?: { m1: number; m5: number; m15: number };
  logicalCores?: number;
  message?: string;
}
```

Attach optionally to environment presentation / server welcome config push (parallel to planned `usageLimits`), keyed by `environmentId`.

### Server read path (sketch)

On each **execution environment** (the T3 server process running on the host):

1. **Linux / macOS:** `os.loadavg()`, `os.freemem()` / `os.totalmem()`, CPU sample via short interval delta or existing platform helpers — keep read **< 100ms**, no shelling out unless necessary.
2. **Windows:** equivalent via WMI or Node APIs where available; mark `unsupported` when not implemented.
3. **WSL / SSH-forwarded remotes:** metrics describe the **remote host** where the server runs (the desired semantics).
4. **Relay-only clients:** client polls each connected environment's server RPC; relay does not aggregate host stats centrally unless product later wants a fleet view.

Expose `server.getHostResourceSnapshot` (poll) and optionally push deltas on the config stream every ~30–60s while connected — same cache/TTL/dedupe patterns as provider usage.

### UI wishlist

| Location | Display |
| --- | --- |
| **Connections** environment row | Compact `CPU 42% · MEM 68% · Load 1.2` next to connection dot; tooltip with cores, bytes, reset time |
| **Environment picker** / sidebar | Warn tint when MEM > 90% or load/core > 1.0 |
| **Settings → Diagnostics** | Host snapshot section above process table when remote |
| **Mobile** connections sheet | Same compact strip as Connections |
| **Cross-env overview** (optional) | Grid like provider usage: compare homelab vs laptop vs cloud VM |

Color thresholds (example): green < 70%, amber 70–90%, red > 90% for memory; load normalized by `logicalCores`.

### Overlap with provider usage dashboard

| Question | Provider usage | Host resources |
| --- | --- | --- |
| Can I afford another agent turn on this **account**? | ✓ | |
| Is this **machine** saturated (compile + agents + IDE)? | | ✓ |
| Which **environment** should I use for a heavy job? | partial | ✓ |

Future "suggested pick" could combine both: e.g. "use remote `build-box` — Codex quota 40% left, host MEM 55%".

### Non-goals (initial wishlist)

- Per-container / cgroups breakdown (unless agentbox later exposes it)
- GPU metrics
- Historical host charts (optional phase 2; reuse `ProcessResourceHistory` bucket pattern)
- Cross-tenant fleet monitoring in relay control plane

### Upstream (`pingdotgg/t3code`)

No dedicated open issue/PR found (2026-07-04) for remote host CPU/memory/load in Connections UI. Adjacent:

- [#671 — first-class remote backend targets](https://github.com/pingdotgg/t3code/issues/671) (closed architecture proposal)
- [#2767 — memory leak after sleep](https://github.com/pingdotgg/t3code/issues/2767) (motivates visibility, not the feature itself)
- Local process diagnostics already in tree — extend upward to **host** scope rather than new parallel system

### Acceptance criteria (when implemented)

- [ ] Connected remote environments show CPU/MEM/load % in Connections (or explicit unavailable)
- [ ] Metrics describe the **remote server host**, not the client's machine
- [ ] Failed host reads do not affect connection state or provider readiness
- [ ] No polling faster than ~30s by default; manual refresh available
- [ ] Documented as advisory; same privacy posture as usage limits (local/relay only as configured)

---

## Related files

| Area | Files |
| --- | --- |
| Contracts | `packages/contracts/src/providerUsage.ts` (new), `server.ts`, `rpc.ts` |
| Cache | `apps/server/src/provider/usageSnapshotCache.ts` (new) or `packages/shared` |
| Codex | `apps/server/src/provider/Layers/CodexAdapter.ts`, `CodexUsageReader.ts` (new) |
| Claude | `apps/server/src/provider/Layers/ClaudeAdapter.ts`, `ClaudeUsageReader.ts` (new) |
| Cursor | `CursorAdapter.ts`, `CursorProvider.ts`, `packages/contracts/src/model.ts` |
| OpenCode | `OpenCodeAdapter.ts`, Go/Z.ai readers (new) |
| RPC / stream | `apps/server/src/ws.ts`, provider service, config push |
| Web UI | `ProviderInstanceCard.tsx`, composer indicator, optional `settings.usage.tsx` |
