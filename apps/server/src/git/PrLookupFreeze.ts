import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * Durable-settle freeze for PR hosting lookups (gh/glab/…).
 *
 * VCS remote status is keyed by worktree cwd, not thread id. Projection maps
 * `thread.settled` / `thread.unsettled` onto worktree paths with a refcount so a
 * shared path only freezes while every interested thread remains settled.
 *
 * Terminal PR freeze (merged/closed last-known) lives in GitManager and does not
 * need this service — it stops re-hitting the provider even when no settle event
 * was written (client-only effective settle on merge).
 */
export class PrLookupFreeze extends Context.Service<
  PrLookupFreeze,
  {
    /** +1 settled thread using this worktree (no-op when path is null/empty). */
    readonly noteWorktreeSettled: (worktreePath: string | null | undefined) => Effect.Effect<void>;
    /** −1 after unsettle; at 0, PR lookup resumes on the next status poll. */
    readonly noteWorktreeUnsettled: (
      worktreePath: string | null | undefined,
    ) => Effect.Effect<void>;
    /** True when at least one settled thread still owns this cwd. */
    readonly isWorktreeSettledFrozen: (cwd: string) => Effect.Effect<boolean>;
  }
>()("t3/git/PrLookupFreeze") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const settledRefCountByCwd = yield* Ref.make(new Map<string, number>());

  const normalizeWorktreeKey = (cwd: string) =>
    fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));

  const adjust = (worktreePath: string | null | undefined, delta: 1 | -1) =>
    Effect.gen(function* () {
      const trimmed = worktreePath?.trim() ?? "";
      if (trimmed.length === 0) {
        return;
      }
      const key = yield* normalizeWorktreeKey(trimmed);
      yield* Ref.update(settledRefCountByCwd, (current) => {
        const next = new Map(current);
        const previous = next.get(key) ?? 0;
        const value = Math.max(0, previous + delta);
        if (value === 0) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
        return next;
      });
    });

  return PrLookupFreeze.of({
    noteWorktreeSettled: (worktreePath) => adjust(worktreePath, 1),
    noteWorktreeUnsettled: (worktreePath) => adjust(worktreePath, -1),
    isWorktreeSettledFrozen: (cwd) =>
      Effect.gen(function* () {
        const key = yield* normalizeWorktreeKey(cwd);
        const counts = yield* Ref.get(settledRefCountByCwd);
        return (counts.get(key) ?? 0) > 0;
      }),
  });
});

export const layer = Layer.effect(PrLookupFreeze, make);
