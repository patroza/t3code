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
- mobile (`eas update --channel preview`)

You can restart the `t3mobile` service to force it to pick up the update.

Only suggest restarting the web server when changes affect it. Do not restart it automatically unless explicitly requested.

Note: `expo export` (even with `--platform web`) only produces local bundles and does **not** publish a mobile OTA update. Use `eas update` for actual deployment to the preview channel.
