/**
 * Pin list vs work-item link identity.
 *
 * The thread-info pin lists every Jira key seen in the Discord thread, including
 * keys the bot wrote itself (pin backfill). Those pin-only keys must not join or
 * import a T3 thread. Link identity is keys a person attached on a turn, plus a
 * one-time legacy snapshot of pin keys that are not bot-only in scanned history.
 */

import { mergeJiraIssueKeys, omitJiraIssueKeys } from "./jiraLinks.ts";

export interface JiraKeyRoleSplitInput {
  readonly existingPinKeys?: ReadonlyArray<string> | undefined;
  /** `undefined` means this link has not been split yet. */
  readonly existingLinkedKeys?: ReadonlyArray<string> | undefined;
  readonly existingBackfillKeys?: ReadonlyArray<string> | undefined;
  readonly humanKeys: ReadonlyArray<string>;
  readonly botKeys: ReadonlyArray<string>;
  readonly maskedKeys?: ReadonlyArray<string> | undefined;
}

export interface JiraKeyRoleSplit {
  readonly pinKeys: ReadonlyArray<string>;
  readonly linkedKeys: ReadonlyArray<string>;
  /** Keys on the pin that must not be used for thread linking. */
  readonly backfillKeys: ReadonlyArray<string>;
  /** Keys that appear in scanned history only on bot messages. */
  readonly botOnlyKeys: ReadonlyArray<string>;
}

export function splitJiraKeysForPinAndLink(input: JiraKeyRoleSplitInput): JiraKeyRoleSplit {
  const masked = mergeJiraIssueKeys([], input.maskedKeys);
  const human = omitJiraIssueKeys(input.humanKeys, masked);
  const humanSet = new Set(human);
  const botOnly = omitJiraIssueKeys(input.botKeys, masked).filter((key) => !humanSet.has(key));

  const pinKeys = omitJiraIssueKeys(
    mergeJiraIssueKeys(input.existingPinKeys, [...human, ...botOnly]),
    masked,
  );

  const linkedKeys =
    input.existingLinkedKeys === undefined
      ? omitJiraIssueKeys(input.existingPinKeys, [...masked, ...botOnly])
      : omitJiraIssueKeys(input.existingLinkedKeys, masked);

  const linkedSet = new Set(linkedKeys);
  const backfillKeys = omitJiraIssueKeys(mergeJiraIssueKeys(input.existingBackfillKeys, botOnly), [
    ...masked,
    ...linkedKeys,
  ]).filter((key) => !linkedSet.has(key));

  return { pinKeys, linkedKeys, backfillKeys, botOnlyKeys: botOnly };
}

export interface CrossLinkJiraRow {
  readonly t3ThreadId: string;
  readonly botOnlyKeys: ReadonlyArray<string>;
  readonly linkedKeys: ReadonlyArray<string>;
  /**
   * Linked keys already stored before this backfill. A key in this list was
   * attached on a turn (or a previous split) and is kept even if another
   * Discord thread for the same T3 session only saw it in a bot message.
   */
  readonly explicitLinkedKeys?: ReadonlyArray<string> | undefined;
}

/**
 * Active links are scanned every boot (the pin still backfills).
 * A tombstone is scanned once, until `linkedJiraIssueKeys` is written.
 * An empty array is that signal: the pin keys were classified and must not
 * be fetched from Discord again on later boots.
 */
export function linkNeedsJiraRoleScan(link: {
  readonly status: string;
  readonly jiraIssueKeys?: ReadonlyArray<string> | undefined;
  readonly linkedJiraIssueKeys?: ReadonlyArray<string> | undefined;
  readonly backfillJiraIssueKeys?: ReadonlyArray<string> | undefined;
}): boolean {
  if (link.status === "active") return true;
  if (link.linkedJiraIssueKeys !== undefined) return false;
  return (link.jiraIssueKeys?.length ?? 0) > 0 || (link.backfillJiraIssueKeys?.length ?? 0) > 0;
}

/**
 * Keys promoted onto link identity while a backfill scan was in flight.
 * `linkedKeysAtStart === undefined` means the row had not been split yet, so
 * any array now stored was written by a turn during the scan.
 */
export function mergePromotedLinkedKeys(input: {
  readonly classifiedLinkedKeys: ReadonlyArray<string>;
  readonly classifiedBackfillKeys: ReadonlyArray<string>;
  readonly linkedKeysAtStart: ReadonlyArray<string> | undefined;
  readonly linkedKeysNow: ReadonlyArray<string> | undefined;
}): { readonly linkedKeys: ReadonlyArray<string>; readonly backfillKeys: ReadonlyArray<string> } {
  const now = input.linkedKeysNow;
  if (now === undefined) {
    return {
      linkedKeys: mergeJiraIssueKeys([], input.classifiedLinkedKeys),
      backfillKeys: mergeJiraIssueKeys([], input.classifiedBackfillKeys),
    };
  }
  const atStart = new Set(mergeJiraIssueKeys([], input.linkedKeysAtStart));
  const promotedDuring = mergeJiraIssueKeys([], now).filter((key) => !atStart.has(key));
  const linkedKeys = mergeJiraIssueKeys(input.classifiedLinkedKeys, promotedDuring);
  const linkedSet = new Set(linkedKeys);
  return {
    linkedKeys,
    backfillKeys: mergeJiraIssueKeys([], input.classifiedBackfillKeys).filter(
      (key) => !linkedSet.has(key),
    ),
  };
}

/**
 * A key that is bot-only on any Discord thread for a T3 session is not link
 * identity on the other threads either, unless a turn already promoted it.
 * Stops a later human mention inside a wrongly joined thread from confirming
 * a key that pin backfill scraped out of the bot's own reply.
 */
export function excludeBotOnlyKeysAcrossLinks<Row extends CrossLinkJiraRow>(
  rows: ReadonlyArray<Row>,
): ReadonlyArray<Row & { readonly linkedKeys: ReadonlyArray<string> }> {
  const botOnlyByThread = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = botOnlyByThread.get(row.t3ThreadId) ?? new Set<string>();
    for (const key of row.botOnlyKeys) set.add(key);
    botOnlyByThread.set(row.t3ThreadId, set);
  }

  return rows.map((row) => {
    const botOnly = botOnlyByThread.get(row.t3ThreadId) ?? new Set<string>();
    const explicit = new Set(mergeJiraIssueKeys([], row.explicitLinkedKeys));
    const linkedKeys = row.linkedKeys.filter((key) => !botOnly.has(key) || explicit.has(key));
    return { ...row, linkedKeys };
  });
}
