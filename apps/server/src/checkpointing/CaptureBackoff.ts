// Back off consecutive checkpoint capture failures per workspace to avoid repeating full-tree work that cannot finish.
// Successful captures clear the cooldown, so transient failures do not penalize later turns.

/** Failures tolerated before a workspace enters cooldown. */
const FAILURE_THRESHOLD = 3;
const BASE_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 60 * 60_000;

/**
 * Only a workspace that later succeeds clears its own record, so a workspace
 * that fails once and is then abandoned would otherwise be retained for the
 * lifetime of the server. Bound the tracked set and evict least-recently
 * touched entries; dropping one only costs a workspace its failure history.
 */
const MAX_TRACKED_WORKSPACES = 256;

// Reserve one retry after cooldown so concurrent threads cannot all launch expensive capture at once.
// The reservation exceeds the process timeout but expires if its caller never reports back.
const ATTEMPT_RESERVATION_MS = 60_000;

export interface CaptureBackoffDecision<E> {
  readonly skip: boolean;
  /** Milliseconds left in the cooldown, for logging. Zero when not skipping. */
  readonly remainingMs: number;
  /**
   * The failure that opened the cooldown. Replayed instead of inventing a new
   * error, so callers keep seeing the real reason capture is unavailable and
   * the error channel is unchanged.
   */
  readonly lastError: E | null;
}

export function cooldownForFailureCount(consecutiveFailures: number): number {
  if (consecutiveFailures < FAILURE_THRESHOLD) return 0;
  const doublings = consecutiveFailures - FAILURE_THRESHOLD;
  // Clamp the exponent before shifting so a long-lived workspace cannot
  // overflow into a negative or infinite cooldown.
  const scale = 2 ** Math.min(doublings, 10);
  return Math.min(BASE_COOLDOWN_MS * scale, MAX_COOLDOWN_MS);
}

export interface CaptureFailureOutcome {
  readonly consecutiveFailures: number;
  /** Zero while the workspace is still under the failure threshold. */
  readonly cooldownMs: number;
}

interface WorkspaceRecord<E> {
  consecutiveFailures: number;
  skipUntilMs: number;
  lastError: E;
}

/**
 * Tracks capture health per workspace. Callers ask whether to skip, then
 * report the outcome of any capture they actually ran.
 */
export function makeCaptureBackoff<E>() {
  const recordByCwd = new Map<string, WorkspaceRecord<E>>();

  /** Move a record to the most-recent position so eviction sees real usage. */
  const touch = (cwd: string, record: WorkspaceRecord<E>) => {
    recordByCwd.delete(cwd);
    recordByCwd.set(cwd, record);
  };

  return {
    /**
     * Decide whether this caller should run a capture. Mutating: a caller
     * released past an expired cooldown reserves the attempt, and any read
     * refreshes eviction recency so a workspace being actively skipped is not
     * evicted by churn from unrelated workspaces.
     */
    beginAttempt(cwd: string, nowMs: number): CaptureBackoffDecision<E> {
      const record = recordByCwd.get(cwd);
      if (!record) {
        return { skip: false, remainingMs: 0, lastError: null };
      }

      touch(cwd, record);
      // Below the threshold a workspace has no cooldown at all, and its zero
      // deadline must not read as one that just expired: reserving there
      // would let a single transient failure suppress a concurrent capture.
      if (record.consecutiveFailures < FAILURE_THRESHOLD) {
        return { skip: false, remainingMs: 0, lastError: null };
      }

      if (nowMs < record.skipUntilMs) {
        return {
          skip: true,
          remainingMs: record.skipUntilMs - nowMs,
          lastError: record.lastError,
        };
      }

      record.skipUntilMs = nowMs + ATTEMPT_RESERVATION_MS;
      return { skip: false, remainingMs: 0, lastError: null };
    },

    recordSuccess(cwd: string): void {
      recordByCwd.delete(cwd);
    },

    recordFailure(cwd: string, nowMs: number, error: E): CaptureFailureOutcome {
      const consecutiveFailures = (recordByCwd.get(cwd)?.consecutiveFailures ?? 0) + 1;
      const cooldownMs = cooldownForFailureCount(consecutiveFailures);
      touch(cwd, {
        consecutiveFailures,
        skipUntilMs: cooldownMs === 0 ? 0 : nowMs + cooldownMs,
        lastError: error,
      });

      while (recordByCwd.size > MAX_TRACKED_WORKSPACES) {
        const oldestCwd = recordByCwd.keys().next().value;
        if (oldestCwd === undefined) break;
        recordByCwd.delete(oldestCwd);
      }

      return { consecutiveFailures, cooldownMs };
    },

    get trackedWorkspaceCount(): number {
      return recordByCwd.size;
    },
  };
}
