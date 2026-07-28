# Macroscope Setup

This repository already carries repo-native Macroscope review instructions under
[`/.macroscope`](../../.macroscope). This runbook covers the remaining manual
workspace setup for this repo and the `effect-app` GitHub organization.

## Repository setup

For this repository, connect the GitHub repository in Macroscope, then enable:

- Code Review
- PR Summaries
- Approvability
- Status

Recommended repo settings after the repository is connected:

1. Set Detection Mode to `Prefer Coverage`.
2. Set minimum blocking severity for correctness to `Medium`.
3. Keep Approvability check conclusions `neutral`; use GitHub reviewer rules to
   block merges rather than a hard-failing approvability check.
4. Merge the `.macroscope` directory on the default branch before expecting the
   new instructions to apply to pull requests.

The repo-specific configuration now lives in:

- [`/.macroscope/check-run-agents/effect-service-conventions.md`](../../.macroscope/check-run-agents/effect-service-conventions.md)
- [`/.macroscope/correctness/repo-architecture.md`](../../.macroscope/correctness/repo-architecture.md)
- [`/.macroscope/correctness/effect-runtime-boundaries.md`](../../.macroscope/correctness/effect-runtime-boundaries.md)
- [`/.macroscope/approvability.md`](../../.macroscope/approvability.md)

## `effect-app` organization setup

As of July 28, 2026, the public GitHub organization is
[`effect-app`](https://github.com/effect-app). Public repositories currently
include `libs`, `boilerplate`, `docs`, `sample`, `shared`, `patchman`,
`tsgo`, `language-service`, `typescript-go`, and related repos.

Recommended workspace bootstrap:

1. Install the Macroscope GitHub App on the `effect-app` organization with
   selected-repository access first, not full-org access by default.
2. Connect the repositories that matter immediately for shared context:
   `libs`, `boilerplate`, `docs`, `shared`, `tsgo`, and `language-service`.
   Add the rest once the workspace is stable.
3. In Status, write a short Product Overview for the organization:
   "Practical Effect-based application platform spanning reusable libraries,
   app templates, docs, and tooling."
4. Choose a weekly Status cadence that matches the team review rhythm.
5. Connect Slack so commit and PR activity can be subscribed in team channels.
6. Connect Jira or Linear if the workspace uses them; Macroscope’s PR
   summaries and agent answers improve when ticket context is available.

## Suggested areas

Define Areas in Macroscope using repository or path groupings that match how
people reason about the code:

- `t3code/server`: `apps/server/**`
- `t3code/web`: `apps/web/**`
- `t3code/mobile`: `apps/mobile/**`
- `t3code/desktop`: `apps/desktop/**`
- `t3code/contracts-and-runtime`: `packages/contracts/**`, `packages/client-runtime/**`, `packages/shared/**`
- `effect-app/libs`: `libs/**` in the `effect-app/libs` repository
- `effect-app/tooling`: `tsgo/**`, `language-service/**`, `typescript-go/**`
- `effect-app/docs`: `docs/**` in the `effect-app/docs` repository

Keep Areas coarse enough to support weekly status summaries and ownership
questions. Do not mirror every package as a separate Area unless the team
already uses that granularity.

## Known follow-up

This repo still does not define `CODEOWNERS`. Macroscope Approvability works
without it, but ownership-aware approval decisions improve once a `CODEOWNERS`
file exists.
