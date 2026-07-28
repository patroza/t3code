---
include:
  - "apps/**/*.ts"
  - "apps/**/*.tsx"
  - "packages/**/*.ts"
  - "packages/**/*.tsx"
  - "*.json"
  - "pnpm-workspace.yaml"
---

**Repository shape.** T3 Code is a monorepo with distinct runtime boundaries. `apps/server` is the Node.js WebSocket server that wraps `codex app-server`; `apps/web` is the React/Vite client; `apps/mobile` and `apps/desktop` are first-party clients; `packages/contracts` contains shared Effect schemas and contracts only; `packages/shared` exposes explicit subpath exports and should not regress into a root barrel; `packages/client-runtime` intentionally has no root export and callers must import narrow public subpaths.

**Contracts are behavior.** Changes under `packages/contracts` are protocol changes. Review them as compatibility-sensitive: server producers, web/mobile/desktop consumers, codecs, and tests must move together. Flag PRs that change a contract shape without updating the code paths that encode, decode, persist, or render that contract.

**Keep package boundaries explicit.** Do not introduce runtime logic into `packages/contracts`. Do not add broad root exports to `packages/client-runtime` or `packages/shared` when the package intentionally relies on explicit subpath APIs. Review changed imports to make sure new code keeps using the narrowest public subpath instead of reaching through internal files.

**Dev topology matters.** Browser development is single-origin through the server/Vite proxy. Flag new local-dev requirements for `VITE_HTTP_URL` or `VITE_WS_URL`, or changes that bypass the normal `/api`, `/ws`, `/oauth`, or `/.well-known` proxy flow for ordinary `dev` or `dev:web` usage.

**Cross-client changes need end-to-end thinking.** When shared runtime, contracts, environment/session logic, or state modules change, review for follow-through across web, mobile, desktop, and server boundaries. A PR that updates the shared layer but leaves one client on stale assumptions is a correctness bug, not a style issue.
