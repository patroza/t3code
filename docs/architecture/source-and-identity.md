# Source attribution & session identity

**Status:** draft design · **Area:** contracts, server auth/orchestration, web/desktop/mobile, integrations  
**Audience:** shared single-environment servers with multiple people and multiple clients

## Problem

Threads and messages have no durable notion of **who** started or participated, or **which surface** they came from. A shared T3 server is used by several humans (and bots) over desktop, web, mobile, Discord, Jira, and eventually GitHub/Slack/Teams. We need:

1. Compact **source** display (channel icons; hover expands location).
2. **Person@channel** handles (`patroza@desktop`, `patroza@discord`).
3. Filters: **mine vs theirs**, **starter vs participant**, **by channel**.
4. Identities that are **not free-form** — only people listed in a **server-side identity map file**.

## Goals

- One environment, many people, many sessions.
- Username is **chosen from the map**, never typed arbitrarily.
- Session-bound claim: “this connection is person X.”
- Source stamped on user turns; thread origin derived from first user message.
- Integrations resolve platform actors via the same map (no second identity system).
- Old events remain valid (`source` optional / null).

## Non-goals (for this design / early PRs)

- Multi-tenant auth with external IdP accounts.
- Free-form custom usernames or per-device nicknames outside the map.
- Full Slack/Teams adapters (channel enum reserved only).
- Backfilling invented provenance for historical threads.
- Client-only identity that the server cannot verify.

## Key decisions

| Decision           | Choice                                                            | Rationale                                    |
| ------------------ | ----------------------------------------------------------------- | -------------------------------------------- |
| Scope of username  | **Per auth session** (claim), not one env-global string           | Shared server; multiple humans               |
| Allowed identities | **Closed set** from server identity map file                      | Operator-controlled; matches Discord bot map |
| Free-form entry    | **Rejected**                                                      | Only map members; no invent-a-handle         |
| Username length    | **No product min/max** (soft wire max only)                       | Map membership is the constraint             |
| Claim UI           | **Typeahead after 3 chars**, not a full dropdown                  | Fewer wrong-person misclicks on large maps   |
| Avatars            | **Generated initials + stable color** first; photos later         | Zero deps, works offline, distinct enough    |
| Map location       | Server file path (env), not client settings                       | Same host of truth as secrets/aliases        |
| Stamp site         | User-originated orchestration events (`message-sent`, turn start) | Source of truth is event log                 |
| Thread origin      | First user message’s `SourceRef`                                  | Simple; no separate origin command for v1    |
| Display            | Icon + hover `username@channel` (+ location)                      | Compact list UX; no GPU-heavy chrome         |
| Mine               | Session’s claimed `personId` equals message/thread person         | Cross-surface via map links                  |

## Concepts

### Person

A human (or bot operator) listed in the identity map.

- Stable **`personId`** (slug or uuid; prefer explicit `id` in map, fallback slug of `username`).
- Required **`username`**: non-empty operator-chosen handle; **normalized lowercase** on the wire. **No min/max product length** — validity is **membership in the map**, not free-form shape rules.
- Optional display **`name`** (for git trailers / tooltips).
- Optional platform links: discord, github, jira, (later slack/teams).

### Channel (client / surface)

How the action entered T3:

```text
desktop | web | mobile | discord | github | jira | slack | teams | bot | unknown
```

T3 UI clients map from existing `ClientKind` / `AuthClientMetadata.deviceType`:

| Runtime signal                        | Channel                                  |
| ------------------------------------- | ---------------------------------------- |
| desktop-renderer / deviceType desktop | `desktop`                                |
| web                                   | `web`                                    |
| mobile / tablet                       | `mobile`                                 |
| bot deviceType / integration          | `discord` / `jira` / … as set by adapter |

### Handle

Display only: `{username}@{channel}` → `patroza@desktop`.

### SourceRef

Compact provenance attached to user messages (and denormalized onto thread shell for lists):

```ts
type SourceRef = {
  channel: SourceChannel;
  personId: string; // required for new writes when identity is enabled
  username: string; // denormalized from map at write time (stable display if map changes later)
  // optional location (channel-specific, all fields optional)
  location?: {
    // discord
    guildId?: string;
    channelId?: string;
    threadId?: string;
    // github
    owner?: string;
    repo?: string;
    number?: number;
    kind?: "pr" | "issue";
    // jira
    projectKey?: string;
    issueKey?: string;
  };
  actor?: {
    platformId?: string; // snowflake, login, accountId as observed
    displayName?: string;
  };
};
```

**Thread origin** = first user message with a `SourceRef`, else null.  
**Participants** = distinct `personId`s on user messages (denormalized on shell).

## Identity map file (closed set)

### Load path

Server config (mirrors Discord bot ops):

```bash
# preferred: under T3 home / secrets
export T3_IDENTITY_MAP_PATH=/run/secrets/identity-map.yaml
# default fallback when unset: $T3CODE_HOME/userdata/identity-map.yaml if present
```

- Missing file → **identity feature off**: no claim gate, no source stamping requirement, filters degraded.
- Present but empty people → treat as off (or misconfig warning).
- Present with people → **identity required** for interactive clients.

Reload: process restart is fine for v1; optional file watch later (bot already has reload patterns to copy).

### Document shape

Compatible with existing Discord bot map, **plus required `username`** per person:

```yaml
# identity-map.yaml
people:
  patroza:
    username: patroza # required; closed-set handle (lowercase on wire)
    name: Patrick Roza # display / Co-authored-by name
    discord:
      id: "95218063095377920"
      username: patroza
    github:
      login: patroza
      id: "42661"
      # email optional; noreply derived when id+login present
    jira:
      accountId: "…"
      email: patrick@example.com
  julius:
    username: julius
    name: Julius
    github:
      login: juliusmarminge
```

Also accept array form and flat keys used by the bot (`discordId`, `githubLogin`, …).  
**Validation rules:**

- Every person must have unique `username` (case-insensitive).
- At least one of: `username` only (T3-only person), or any platform link.
- `username` non-empty after trim; stored/compared case-insensitively.
- Unknown fields ignored (forward compatible).

Promote parsing into **`packages/shared` or `packages/contracts` + server loader** so Discord bot and server share one parser over time (bot can keep a thin re-export). First PR may vendor a copy if package boundaries are awkward; converge in a follow-up.

### Not free-form

Interactive claim API accepts **only** a `personId` or `username` that exists in the loaded map.  
Any other value → `identity_unknown_person`.

## Session claim (who is this connection)

### Model

Extend auth session (or a side table keyed by `sessionId`) with:

```ts
type SessionIdentityClaim = {
  sessionId: AuthSessionId;
  personId: string;
  username: string; // snapshot from map at claim time
  claimedAt: DateTime;
  // optional: how they claimed
  method: "typeahead" | "auto-discord" | "auto-jira" | "bootstrap";
};
```

- **One claim per session.** Re-claim allowed only to the same person, or via explicit “switch person” that requires re-claim (admin/debug); default: immutable after set.
- **Not** stored in client settings blob as source of truth (client may cache for UI).
- Pairing links remain capability grants; claim is an extra session attribute after auth.

### Bootstrap / bots

| Client                         | Claim path                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| Web / desktop / mobile         | After pairing: **typeahead claim** against map usernames; must claim before operate |
| Discord bot                    | Auto-resolve sender snowflake → person; stamp on turn; no UI                        |
| Jira bot                       | Auto-resolve accountId/email → person                                               |
| Headless CLI / admin bootstrap | Optional claim; if identity-on and operate without claim → reject operate RPCs      |

### Gate

When identity map is **enabled** (non-empty people):

- RPCs that need `orchestration:operate` (and thread create/send) require a claimed session.
- Allow without claim: auth/pairing, access admin, identity list + claim endpoints, health, shell **read** optional (prefer read allowed so UI can show claim gate over empty shell).
- UI: full chrome locked behind claim screen (“Who are you?”). See typeahead below — **not** a full dropdown of everyone.

When map **disabled**: behavior unchanged from today (no gate, no source required).

## Stamping turns

On `thread.turn.start` / user `thread.message-sent`:

1. Resolve `SourceRef` **on the server** from session claim + client channel metadata.  
   Clients **must not** be trusted to send arbitrary `personId`/`username`. They may send channel hints already present (device type); server overwrites person fields from claim.
2. Integrations attach platform `actor` + `location`; server resolves person via map; if unresolved → message still sent with `personId` omitted or `unknown` policy:

   **v1 policy:** unresolved external actor → stamp channel + actor only, `personId` null; does not count as mine for anyone. Log once per turn.

3. Projector copies `source` onto `OrchestrationMessage`.
4. Shell projector maintains `originSource` and `participantPersonIds`.

### Shell fields (list/filter)

```ts
// OrchestrationThreadShell additions (all optional for decode)
originSource: SourceRef | null;
participantPersonIds: string[];  // max N denormalized; full set not required for v1 if costly — prefer full small set
```

Filters (client-side over shell):

- Ownership: mine | theirs | any (`personId === session.claim.personId`)
- Role: starter (origin person) | participant (in set)
- Channel: multi-select on `originSource.channel` (v1); optional “any message channel” later

## UI

### Compact display

- Thread row: channel **icon** for origin + optional **micro avatar** for origin person; tooltip `username@channel` + location one-liner.
- Message: micro avatar (person) + tiny channel glyph; tooltip full handle.
- Icons only; no continuous animation.

### Micro avatars (generated first)

v1 does **not** load GitHub/Discord profile photos. Generate chips on the fly:

- Pure helper: `@t3tools/shared/identityAvatar` → `{ initials, backgroundColor, color, label }`.
- **Initials**: display `name` when present (`Patrick Roza` → `PR`), else first two letters of `username` (`patroza` → `PA`).
- **Color**: stable hash of `personId` (fallback username) into a fixed muted palette — same person ⇒ same chip on every client.
- **Sizes**: micro ~14–16px in thread lists / message rows; ~24–28px in typeahead suggestions and settings.
- **Later**: optional real image URL from map/platform, falling back to the generated chip.
- No new dependency (avoids pulling in full avatar libs); logic matches the usual initials+hue pattern.

### Identity claim UI (typeahead, not a full dropdown)

Goal: reduce mis-clicks on the wrong person when the map is large; still **closed-set only**.

- Full-screen / modal after connect when unclaimed and map enabled.
- Single text field: user types their username (and/or display name).
- **No full-list dropdown** of all people by default.
- After **`IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS` (3)** characters, show matching suggestions from the map (prefix/substring on `username` and `name`, case-insensitive).
- User must **select a suggestion** or submit an **exact** map username match. Free-form values that are not in the map are rejected (client validation + server `identity_unknown_person`).
- Suggestion rows: **micro avatar** + `username` primary, `name` secondary, optional platform badges.
- Selecting / exact confirm calls `identity.claim` with `personId` or `username`.
- Change identity: Settings → rare; clears claim and re-runs typeahead (or admin-only).

### Filters entry points

Sidebar / command palette: Mine | Theirs; Starter | Participant; source chips.

## API sketch (contracts)

New module `packages/contracts/src/identity.ts` (see initial draft in repo):

- `IdentityUsername`, `PersonId`, `SourceChannel`, `SourceRef`
- `IdentityPersonPublic` (safe for clients: no emails required in list; emails may be omitted from public DTO)
- `IdentitySnapshot` — `{ enabled, people: IdentityPersonPublic[] }`
- RPC:
  - `identity.getSnapshot` → map public view + whether claim required
  - `identity.getSessionClaim` → current claim or null
  - `identity.claim` → `{ username | personId }` validated against map
- Auth session list may show claimed username next to device label

Orchestration:

- Optional `source` on message payloads and shell (decode defaults null/[]).

## Server layout

```text
apps/server/src/identity/
  IdentityMap.ts          # load/parse/validate file
  IdentityMapStore.ts     # Effect service, path from config
  SessionIdentity.ts      # claim persistence (sqlite)
  IdentityRpc.ts          # handlers + gate helper
```

Persistence: session claim columns on existing auth session table **or** `session_identity(session_id PK, person_id, username, claimed_at)`. Prefer side table to avoid heavy SessionStore churn.

Gate helper used by orchestration command dispatch:

```ts
requireSessionIdentity(session): Effect<Claim, IdentityClaimRequiredError>
```

## Discord / Jira bots

- Prefer **same file** path already used (`T3_IDENTITY_MAP_PATH`) so ops do not maintain two maps.
- When calling T3 turn APIs, bots either:
  - use a bot session that passes platform actor in a trusted integration path, and server maps to person, or
  - claim is not used; integration reactor stamps `SourceRef` server-side when ingesting.

Until server owns the map, bots keep co-author resolution as today; **P2** unifies parser + stamp.

## Migration / compatibility

| Artifact               | Behavior                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Old messages           | `source: null`                                                                                                                           |
| Old shells             | `originSource: null`, empty participants                                                                                                 |
| Map without `username` | Reject load or derive from github.login / key if valid slug; **prefer fail load with clear error** so operators add usernames explicitly |
| Feature flag           | Implicit: map present + people ⇒ on                                                                                                      |

## Phased PR plan

### PR1 — Contracts + map schema + design doc

- Land this design doc.
- Add `identity.ts` schemas + tests (username wire form, SourceRef decode, typeahead constant).
- No runtime behavior.

### PR2 — Server identity map load + claim RPC + session persistence

- Load `T3_IDENTITY_MAP_PATH` / default path.
- `identity.getSnapshot` / `claim` / `getSessionClaim`.
- Gate `orchestration:operate` when enabled.
- Unit tests with temp map files.

### PR3 — Stamp SourceRef on T3 client turns

- Derive channel from session client metadata.
- Attach source on message-sent / projector / shell origin + participants.
- Focused orchestration tests (receipts, no sleeps).

### PR4 — Web/desktop/mobile: typeahead claim gate + compact icons

- Claim gate UI (all entry points: first paint after pair, not only settings).
- Typeahead after 3 chars; no full-people dropdown; reject non-map values.
- Micro avatars via `@t3tools/shared/identityAvatar` (initials + palette); thin React/RN chip wrappers.
- Thread/message source icons + tooltips.
- Client settings may cache last username for prefill only if still in map.

### PR5 — Filters (mine / theirs / starter / participant / channel)

- Shell-driven client filters + command palette.
- Mobile parity for filter entry (simpler sheet).

### PR6 — Integrations stamp external sources

- Discord bot passes location + actor; server resolves person.
- Jira similarly.
- Shared map parser extraction if not done in PR2.

## Testing strategy

- Map parse: valid/invalid username, duplicates, missing username.
- Claim: accepts map member; rejects unknown; rejects operate without claim when enabled.
- Stamp: desktop session → `channel: desktop`, correct personId.
- Shell: first message sets origin; second person adds participant.
- Gate off when map absent.
- Decode old events without `source`.

## Open questions (resolved defaults)

| Question                            | Default for implementation                             |
| ----------------------------------- | ------------------------------------------------------ |
| Map empty vs missing                | Both = feature off                                     |
| Can two sessions claim same person? | **Yes** (same human, phone + desktop)                  |
| Switch person mid-session           | Settings action; new claim overwrites                  |
| Emails in client snapshot           | **Omit** by default (github login / discord id ok)     |
| Unmapped Discord user               | Stamp actor only; not mine                             |
| Username rename in map              | Old events keep denormalized username; personId stable |

## Surfaces checklist

| Surface           | Notes                                                             |
| ----------------- | ----------------------------------------------------------------- |
| Contracts         | SourceRef, identity RPC, message/shell fields                     |
| Server            | Map, claim, gate, stamp, project                                  |
| Web               | Gate, icons, filters                                              |
| Desktop           | Same web UI + deviceType desktop                                  |
| Mobile            | Gate + icons + simplified filters                                 |
| Discord/Jira bots | External SourceRef (PR6)                                          |
| Docs              | This file; user-facing note under `docs/user/` when shipping gate |

## Appendix: example handle matrix

| Actor                             | Channel | Handle            |
| --------------------------------- | ------- | ----------------- |
| Patrick on Mac app                | desktop | `patroza@desktop` |
| Patrick in browser                | web     | `patroza@web`     |
| Patrick on phone                  | mobile  | `patroza@mobile`  |
| Patrick via Discord               | discord | `patroza@discord` |
| Julius via GitHub-originated flow | github  | `julius@github`   |
