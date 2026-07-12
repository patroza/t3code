# AGENTS-PATROZA.md

Personal workflow preferences.

## Commit and sync

- After every meaningful increment, commit and sync.
- Make sure the PR has a full overview of the feature diff against `main`.

## Rebuild and redeploy

After finishing the requested work, rebuild + redeploy:

- web
- server
- desktop (dir script: `scripts/build-and-deploy-dir.sh`)
- mobile (expo)

You can restart the `t3mobile` service.

Only suggest restarting the web server when changes affect it. Do not restart it automatically unless explicitly requested.
