# Provider Usage Follow-ups

The provider usage implementation on `patroza/import-external-sessions` supersedes the reader
architecture proposed in `patroza/t3code#2`. It already provides advisory provider-defined windows,
plan and pace information, stale/error handling, and web, mobile, and VS Code indicators through the
environment-local `ai-usage` feed.

The following product surfaces from that proposal remain useful and are intentionally retained as
follow-up scope:

- Detailed usage blocks on provider instance cards, including explicit unavailable/unsupported copy.
- Manual refresh for one provider and refresh-all for the environment.
- A cross-provider comparison surface for choosing an account/model before starting work.
- Strong same-driver multi-instance isolation. The current daemon feed is provider keyed, so T3 must
  not imply instance-level isolation until the feed exposes a stable instance identity.
- Provider capability notes for Cursor Composer, OpenCode Go versus Z.ai, and Grok when their usage
  APIs become stable enough to expose without hidden polling.

These remain advisory. Missing or stale quota data must never block connecting, starting a session,
listing models, or sending a turn.
