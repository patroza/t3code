---
name: test-t3-app
description: Test T3 Code's web and desktop UI through its built-in Browser panel against isolated development state. Use for browser verification, browser pairing recovery, and test fixtures. Use test-t3-mobile for native mobile verification.
---

# Test T3 web and desktop

Use T3's built-in Browser panel for verification. If its tools are absent or
the panel reports unavailable, explain the blocker and stop verification.
Do not install or switch to another automation system. For native mobile
testing, use [test-t3-mobile](../test-t3-mobile/SKILL.md).

## Start the app

Reuse this task's healthy dev server. Otherwise run `vp run dev` from the
repository root and retain its terminal session. Use the worktree's ignored
`.t3` state and read the actual ports and pairing URL from the dev-runner output.
Never run against `~/.t3/userdata` or set `VITE_HTTP_URL` or `VITE_WS_URL`.

The worktree-local default deliberately outranks an ambient `T3CODE_HOME`; do
not pass the shared home through to a worktree dev server. Ports can shift when
occupied — always read the actual values from the `[dev-runner]` line. Do not
pass `--browser` during automated testing: an automatically opened page can
consume the one-time bootstrap token before the controlled browser uses it.

Test with meaningful project and thread data. Read
[references/sqlite-fixtures.md](references/sqlite-fixtures.md) only when
inspecting or seeding SQLite. Stop the test server before direct fixture writes.

## Use the Browser panel

Call `preview_status`, then `preview_open` if the Browser panel is
closed. Navigate to the complete startup pairing URL once with
`preview_navigate`, then use `preview_snapshot` and T3's interaction tools.
If the token was consumed or expired, run `node apps/server/src/bin.ts pair`
for a fresh one. Keep using the same tab.

Tokens from `pair` carry standard client scopes. The startup pairing URL carries
admin scopes; if the user needs Settings → Connections management (`access:write`),
restart the server and hand over the new startup URL instead.

### Previewing the dev server from a remote client

When T3 itself is being driven from another machine — the app connected to this environment over a
tailnet or LAN address rather than `localhost` — a dev server bound to loopback is not reachable at
that address just because the hostname is. Opening it does **not** require `--share`: the
environment resolves the port on demand, reusing an existing `tailscale serve` route, using the
environment's own address when the port already answers there, and otherwise publishing a
tailnet-only HTTPS route for the port and withdrawing it when the dev server exits.

Give the preview a `localhost:<port>` URL and let it resolve. Never hand-write the environment's
hostname with the dev port appended — that is the shape that fails, because nothing promises the
dev port is published under the same number or scheme.

If the port cannot be made reachable, the preview reports why and what to do (dev server not
running, tailscale not logged in, no permission to manage routes, tailnet port already taken).
Treat that message as the result; do not retry the same URL.

### Verify a shared environment before human handoff

When another person will use the printed pairing URL, first open the shared origin without the pairing path or fragment in the controlled browser and confirm the T3 Code app loads. This browser navigation is required even when curl succeeds because browsers block some otherwise reachable ports before making a network request.

Do not open the other person's complete pairing URL during this reachability check; doing so consumes its one-time token. If the agent also needs an authenticated browser, create and consume a separate pairing token, then leave a fresh token for the other person.

## Verify and retain

Exercise the affected flow and capture the state that proves it works. Keep
the server, state, and panel available while the user inspects or iterates.
An assistant turn ending is not teardown. Stop only processes you started,
using retained terminal sessions or captured PIDs.

When sharing is requested, start with `vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.
