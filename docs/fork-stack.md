# Fork branch topology

How this fork's branches relate. The operating model — contributing, releasing, syncing upstream —
is [stable-dev-release-branch-handover.md](./stable-dev-release-branch-handover.md).

```text
pingdotgg/t3code:main
    └── main                  exact upstream mirror, fast-forward only
            └── fork/dev      canonical product: contributor target and release source
```

| Branch             | Rewritten      | Role                                                                         |
| ------------------ | -------------- | ---------------------------------------------------------------------------- |
| `main`             | mirror-managed | Exact copy of `pingdotgg/t3code:main`. Never receives downstream work.       |
| `fork/dev`         | **never**      | The product. Every PR targets it; every release comes from it.               |
| `fork/base`        | was            | Fork-only CI plumbing. Permanent draft PR #255 against `main`.               |
| `fork/tim`         | was            | Selected Tim Smart imports. Permanent draft PR #1.                           |
| `fork/candidates`  | was            | Selected open upstream PRs. Permanent draft PR #27.                          |
| `fork/changes`     | was            | Superseded by `fork/dev`. Frozen; delete once its remaining PRs are drained. |
| `fork/integration` | was            | Superseded by `fork/dev`. Frozen.                                            |

## Upstream

`upstream/main` is merged straight into `fork/dev`, and `main` is fast-forwarded to the same tip.
Because upstream is append-only, `fork/dev` carries its real commits, so the branch page's "commits
behind" is accurate. See
[Synchronizing Upstream](./stable-dev-release-branch-handover.md#synchronizing-upstream-into-forkdev).

## The provenance branches

`fork/base`, `fork/tim` and `fork/candidates` record which upstream and Tim work was selected before
upstream accepted it. Their content is already in `fork/dev`, and **they are no longer rebuilt when
upstream moves** — the tooling that rebased them has been removed.

Their PRs stay **draft**, enforced by `managed-pr-draft-lock.yml`. That matters most for #255: it
targets `main`, so merging it would push fork CI plumbing into the upstream mirror.

Do not merge them. Do not target them with new work.

## Integration overlays

Retired. The four registered overlays were drained into `fork/dev`, their PRs closed, and
`integrationOverlays` emptied. `.github/pr-stack.json` survives only as the allowlist for the draft
lock. There is no overlay to create, target, or compose.
