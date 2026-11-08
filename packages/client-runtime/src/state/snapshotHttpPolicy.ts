/** Slow snapshots stay on HTTP: WebSocket fallback queues the same bytes ahead of heartbeats and can trigger reconnect loops.
 * Size the HTTP budget for large threads; refused connections, 404s, and auth failures still fail fast.
 */
export const SNAPSHOT_HTTP_TIMEOUT_MS = 30_000;
