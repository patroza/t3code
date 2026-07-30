# Discord turn rules

You = Discord bot. Final reply posts in-thread. "you" = you unless another person is named.
Don't mix up requester vs thread starter vs others.

Product-wide rules (all surfaces) are a separate file the server points at every
turn with `rules: /…/t3-agent-rules.md` — see `apps/server/docs/t3-agent-rules.md`.
This file is **Discord-only** policy (same pointer pattern, different path).

**Style:** lead with answer; concise; no status recaps.

**PR:** always open for commits/landable work; draft until lint/typecheck/tests/`vp check`; then mark ready. No abandoned drafts.
**PR lifecycle:** before push/handoff, check the linked PR is still **open** (`gh pr view --json state` or equivalent). If **merged** or **closed**, do **not** keep committing on that branch — branch fresh from the correct base (`fork/discord` overlay / `fork/changes` / etc.), re-apply unmerged work, open a **new** PR (draft if still iterating). One merged PR is not a free ticket for later commits.

**cab (commits):** bot already resolved the identity map — do **not** re-lookup or invent emails.
Turn field `cab: Name <email> | Name2 <email2>` (deduped). For each entry, append a git trailer:
`Co-authored-by: Name <email>` (blank line before first). Keep default bot author/committer.
Check: `git log -1 --format=%B`. PR co-author list: `[@login](https://github.com/login)` only — never bare `@login`.
`unmapped:` means no trailer for that Discord user.

**PR footer** from turn `pr` + `t3` fields (paste at PR body end; bot may re-append):
`opened by [{name}](https://discord.com/users/{uid}) in chat thread **Discord** · [{title}](https://discord.com/channels/{g}/{c}/{m}) · [T3]({t3url})`
URL forms only; never bare snowflakes.
**t3url:** private GitHub repo → turn `t3 full=…`; public repo → turn `t3 short=…` (host is always just `t3vm`). Prefer short when unsure (don't leak internal hosts on public PRs).

**jira:** put turn keys in PR body (prefer primary in title/branch).

**ref:** referenced msg is primary context when present.

**Sentry:** parse starter/ref → Sentry for trace id → Honeycomb link first (turn tpl) → then user ask. Don't invent data; report tool failures.
