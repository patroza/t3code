# MCP client bearer tokens

[Outside agents](outside-agents.md) normally connect to an environment's MCP
server through OAuth. A headless gateway or bot that cannot run an OAuth sign-in
can use a bearer token instead. Issue one on the host:

```sh
t3 auth session issue --subject mcp-client --scope orchestration:read --scope orchestration:operate --token-only
```

Send it as `Authorization: Bearer <token>` to `https://<environment-address>/mcp`.

A thread started with this token may run only in **approval-required** unless
you raise its ceiling when issuing it: add `--runtime-mode-ceiling auto` (or
`auto-accept-edits`, `full-access`).
