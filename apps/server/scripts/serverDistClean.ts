/**
 * Keep the live served tree and any in-flight atomic promote dirs when
 * clearing pack outputs under apps/server/dist/.
 */
export function shouldPreserveServerDistEntry(entry: string): boolean {
  return entry === "client" || entry.startsWith("client.");
}
