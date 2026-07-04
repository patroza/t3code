# Remote Host Resource Visibility (Wishlist)

Status: **wishlist / planning**

Related: [provider usage and quota stats](provider-usage-stats-overview.md) — provider quota answers "can this **account** take another turn?"; host resources answer "is this **machine** saturated?"

## Goal

When you have **multiple environments** (local desktop, SSH box, WSL, relay-linked remote, future agentbox), show **CPU, memory, and load** for each connected remote at a glance — without opening Diagnostics or SSHing in to run `top`.

Today T3 can answer "which Codex account has quota left?" but not "is my remote dev box already at 95% RAM?"

### Design rule

Host resource information is **advisory only**. It must not block connect, send turns, environment switching, or provider readiness.

---

## What exists today

| Surface | Scope | Metrics |
| --- | --- | --- |
| [`server.getProcessDiagnostics`](packages/contracts/src/rpc.ts) / [`ProcessDiagnostics`](apps/server/src/diagnostics/ProcessDiagnostics.ts) | **T3 process tree only** on the connected server | Per-process `cpuPercent`, `rssBytes`; totals for server subtree |
| [`server.getProcessResourceHistory`](packages/contracts/src/rpc.ts) / [`ProcessResourceMonitor`](apps/server/src/diagnostics/ProcessResourceMonitor.ts) | Same — sampled history for T3 processes | Bucketed CPU %, max RSS |
| Settings → Diagnostics UI | Connected environment | Process table ([`DiagnosticsSettings.tsx`](apps/web/src/components/settings/DiagnosticsSettings.tsx)) |
| Connections / environment rows | All saved environments | **Connection phase only** (connected / connecting / error) — no host stats ([`ConnectionsSettings.tsx`](apps/web/src/components/settings/ConnectionsSettings.tsx)) |
| Mobile workspace status | Connected environments | Disconnected / reconnecting label only ([`WorkspaceConnectionStatus.tsx`](apps/mobile/src/features/home/WorkspaceConnectionStatus.tsx)) |

**Gap:** no **host-level** snapshot (system CPU %, memory used/total, load average) exposed per `ExecutionEnvironment`, and no compact % display on remote rows in Connections or the environment picker.

---

## Target UX

For each **connected remote** (and optionally local), show at a glance:

- **CPU** — system-wide utilization % (or normalized per-core busy %)
- **Memory** — used / total % (and optionally available bytes)
- **Load** — 1/5/15-minute load average, normalized by core count where useful (e.g. load ÷ cores as a pressure hint)

### UI placement

| Location | Display |
| --- | --- |
| **Connections** environment row | Compact `CPU 42% · MEM 68% · Load 1.2` next to connection dot; tooltip with cores and bytes |
| **Environment picker** / sidebar | Warn tint when MEM > 90% or load/core > 1.0 |
| **Settings → Diagnostics** | Host snapshot section above process table |
| **Mobile** connections sheet | Same compact strip as Connections |
| **Cross-env overview** (optional) | Grid comparing homelab vs laptop vs cloud VM |

Color thresholds (example): green < 70%, amber 70–90%, red > 90% for memory; load normalized by `logicalCores`.

---

## Suggested contract

Add to `packages/contracts` (schema-only). Attach optionally to environment presentation / config push, keyed by `environmentId`.

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

---

## Server read path (sketch)

On each **execution environment** (the T3 server process running on the host):

1. **Linux / macOS:** `os.loadavg()`, `os.freemem()` / `os.totalmem()`, CPU sample via short interval delta — keep read **< 100ms**, avoid shelling out unless necessary.
2. **Windows:** equivalent via WMI or Node APIs where available; mark `unsupported` when not implemented.
3. **WSL / SSH-forwarded remotes:** metrics describe the **remote host** where the server runs (desired semantics).
4. **Relay clients:** poll each connected environment's server RPC; relay does not aggregate host stats centrally unless product later wants a fleet view.

Expose `server.getHostResourceSnapshot` (poll) and optionally push on the config stream every ~30–60s while connected — reuse cache/TTL/dedupe patterns from provider usage (see [provider-usage-stats-overview.md](provider-usage-stats-overview.md)).

---

## Overlap with provider usage

| Question | Provider usage | Host resources |
| --- | --- | --- |
| Can I afford another agent turn on this **account**? | ✓ | |
| Is this **machine** saturated (compile + agents + IDE)? | | ✓ |
| Which **environment** should I use for a heavy job? | partial | ✓ |

Future combined "suggested pick": e.g. "use remote `build-box` — Codex quota 40% left, host MEM 55%".

---

## Non-goals (initial)

- Per-container / cgroups breakdown (unless agentbox later exposes it)
- GPU metrics
- Historical host charts (optional phase 2; reuse `ProcessResourceHistory` bucket pattern)
- Cross-tenant fleet monitoring in relay control plane

---

## Upstream (`pingdotgg/t3code`)

No dedicated open issue/PR found (2026-07-04) for remote host CPU/memory/load in Connections UI. Adjacent:

- [#671 — first-class remote backend targets](https://github.com/pingdotgg/t3code/issues/671) (closed architecture proposal)
- [#2767 — memory leak after sleep](https://github.com/pingdotgg/t3code/issues/2767) (motivates visibility, not the feature itself)

Local process diagnostics already exist — extend upward to **host** scope rather than building a parallel system.

---

## Implementation phases (sketch)

### Phase 1 — Contract + server read

1. `ServerHostResourceSnapshot` in contracts + RPC `server.getHostResourceSnapshot`
2. Host probe module (`apps/server/src/diagnostics/HostResourceProbe.ts` or similar)
3. TTL cache + timeout; never block connection lifecycle

### Phase 2 — UI

4. Compact strip on Connections environment rows
5. Optional push via config stream while connected

### Phase 3 — Polish

6. Mobile mirror
7. Cross-environment overview grid
8. Optional history buckets (reuse `ProcessResourceMonitor` patterns)

---

## Acceptance criteria

- [ ] Connected remote environments show CPU/MEM/load % in Connections (or explicit unavailable)
- [ ] Metrics describe the **remote server host**, not the client's machine
- [ ] Failed host reads do not affect connection state or provider readiness
- [ ] No polling faster than ~30s by default; manual refresh available
- [ ] Documented as advisory; same privacy posture as usage limits (local/relay only as configured)
- [ ] `vp check` and `vp run typecheck` pass before implementation is considered complete

---

## Related files

| Area | Files |
| --- | --- |
| Contracts | `packages/contracts/src/server.ts`, `rpc.ts` (new snapshot + RPC) |
| Server probe | `apps/server/src/diagnostics/` (new host probe alongside `ProcessDiagnostics.ts`) |
| Web UI | `ConnectionsSettings.tsx`, optional `DiagnosticsSettings.tsx` extension |
| Mobile | `WorkspaceConnectionStatus.tsx`, connections settings screens |
| Architecture | [docs/architecture/remote.md](../docs/architecture/remote.md) |
