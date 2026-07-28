---
include:
  - "apps/server/**/*.ts"
  - "packages/effect-acp/**/*.ts"
  - "packages/effect-codex-app-server/**/*.ts"
  - "packages/shared/**/*.ts"
  - "packages/client-runtime/**/*.ts"
exclude:
  - "**/*.test.ts"
  - "**/*.test.tsx"
---

**Effect module conventions.** In touched Effect-heavy code, prefer subpath namespace imports such as `effect/Effect`, `effect/Layer`, and `effect/Schema` rather than consolidated named imports from `"effect"`. At service boundaries, prefer importing local service modules as namespaces and using their public module shape instead of aliasing `make` or `layer` into ad hoc local names.

**Runtime ownership.** `ManagedRuntime.make`, `runPromise`, and `runPromiseExit` belong at explicit application boundaries such as CLI entrypoints, framework adapters, or imperative bridges. Flag their introduction inside domain services, repositories, persistence layers, or other Effect service constructors where they would hide dependencies or smuggle runtime ownership across the graph.

**Dependency acquisition.** Production service implementations should acquire owned Effect services from the environment rather than accepting sibling service instances as constructor arguments. Passing service instances directly is acceptable in tests and integration harnesses, but in production code it usually indicates hidden dependency injection and a layer boundary that should stay explicit.

**Structured failures.** When touched code defines or translates service errors, prefer structured `Schema.TaggedErrorClass` errors with stable fields over opaque message-only errors. Wrapper messages should come from structural attributes, and the underlying error should remain available as `cause` when the failure is a translation boundary rather than a new domain failure.
