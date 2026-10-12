# New features and processes

Rules for adding or changing a feature or a process. Add the next rule to this page when one is agreed.

## 1. Start from what already exists

Existing features, UX, and UI are the basis of new work. A new process is based on a process the project already runs.

Before designing or implementing:

1. Find the closest existing feature, screen, command, setting, or process.
2. Reuse its entry points, layout, components, wording, empty and error states, and the way back out. Web controls and composition are in [Web UI](../internals/web-ui.md). Clients, providers, and reverse states are in [Hit every surface](../../AGENTS.md#hit-every-surface).
3. Extend that basis. A setting, command, or step on an existing surface comes before a new screen or a second way to do the same job.
4. A new maintainer process extends the one already documented, such as the branch model, the ship gate, the pull request template, or release. Add the step that process cannot already express.
5. When the existing basis cannot carry the change, name that limit in the pull request. Record the decision there. Leave no parallel feature or process beside one that already does the job.

A bug fix that restores current behavior does not add a feature. The report still names the behavior it restores.

## Pull request report

Every pull request includes an **Existing product** section. That section is the record that rule 1 was checked and confirmed. Fill in the four lines. The checklist tick does not replace them.

```md
## Existing product

Checked and confirmed against the current product.

- Closest existing behavior:
- Reused:
- New, and why the existing basis could not carry it:
- Surfaces compared:
```

For a fix that only restores current behavior:

```md
## Existing product

Checked and confirmed. This restores <existing behavior>. No new feature, UX, or process.
```

Keep the section on docs-only and process changes. Name the existing doc or process the change extends.
