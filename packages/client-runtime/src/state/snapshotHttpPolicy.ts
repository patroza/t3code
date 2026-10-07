/**
 * How long a snapshot may take to load over HTTP before the client gives up and
 * lets the WebSocket subscription embed it instead.
 *
 * The socket fallback is not the cheaper path it reads as. It carries the same
 * snapshot over the one connection that also carries the heartbeat and every
 * live event, and it cannot be compressed by the transport the way the HTTP
 * response is. A link too slow to finish the download in time is exactly the
 * link that cannot absorb the same bytes on the socket: the snapshot queues
 * ahead of the heartbeat, the connection is declared dead, and the reconnect
 * asks for the whole snapshot again — the loop reported in #2761, where a
 * heartbeat frame sat behind 72 MB of queued data.
 *
 * So a slow link needs a longer budget here, not a heavier channel. This is
 * sized for that rather than for the multi-KB payload the original bound
 * assumed: real threads have been measured at 78 MiB of encoded snapshot
 * (#4005) and 254 MB of activity payloads (#4008).
 *
 * Slowness is the only failure this waits on. A refused connection, a 404, or
 * an auth failure still fails fast and falls back immediately, so an endpoint
 * that is genuinely unusable is not waited out.
 */
export const SNAPSHOT_HTTP_TIMEOUT_MS = 30_000;
