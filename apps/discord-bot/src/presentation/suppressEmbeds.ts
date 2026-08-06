/**
 * Discord MessageFlags.SuppressEmbeds (1 << 2).
 * Blocks automatic link previews / URL embeds. Does **not** affect file attachments.
 *
 * Numeric constant (not dfx import) so pure helpers stay mock-friendly in tests.
 * @see https://discord.com/developers/docs/resources/message#message-object-message-flags
 */
export const SUPPRESS_EMBEDS_FLAG = 4;

/** Discord MessageFlags.Ephemeral (1 << 6) — for interaction replies only. */
const EPHEMERAL_FLAG = 64;

/**
 * Merge SuppressEmbeds into create/edit message options (or interaction `data`).
 * Preserves existing flags (e.g. Ephemeral).
 */
export function withSuppressEmbeds<T extends object>(
  options: T,
): Omit<T, "flags"> & { flags: number } {
  const existing = (options as { flags?: number | null | undefined }).flags;
  const flags =
    existing === null || existing === undefined
      ? SUPPRESS_EMBEDS_FLAG
      : Number(existing) | SUPPRESS_EMBEDS_FLAG;
  return { ...options, flags };
}

/** Flag bits for interaction message replies: always suppress embeds; optional ephemeral. */
export function interactionMessageFlags(options?: { readonly ephemeral?: boolean }): number {
  return options?.ephemeral === true ? EPHEMERAL_FLAG | SUPPRESS_EMBEDS_FLAG : SUPPRESS_EMBEDS_FLAG;
}
