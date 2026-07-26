import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo, useRef } from "react";

import { vcsEnvironment } from "../../state/vcs";
import { boardGitKey } from "./Board.logic";

export interface BoardVcsTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

const EMPTY_STATUSES_ATOM = Atom.make(
  (): ReadonlyMap<string, VcsStatusResult | null> => new Map(),
).pipe(Atom.withLabel("web:board-vcs-statuses:empty"));

/**
 * Aggregated VCS status subscription for the board: one derived atom over the
 * per-cwd status subscription family, read with a single useAtomValue. The
 * family dedupes identical (environmentId, cwd) keys into one WS subscription
 * and keeps entries warm for 5 minutes after last use, so filter toggles
 * don't churn subscriptions. Entries are `null` until the first snapshot
 * streams in.
 */
export function useBoardVcsStatuses(
  targets: ReadonlyArray<BoardVcsTarget>,
): ReadonlyMap<string, VcsStatusResult | null> {
  // Thread-shell churn hands this hook a fresh input array on every update;
  // dedupe into a sorted, identity-stable list so the derived atom below is
  // only rebuilt when the (environmentId, cwd) set actually changes.
  const previousTargetsRef = useRef<ReadonlyArray<readonly [string, BoardVcsTarget]>>([]);
  const dedupedTargets = useMemo(() => {
    const byKey = new Map<string, BoardVcsTarget>();
    for (const target of targets) {
      byKey.set(boardGitKey(target.environmentId, target.cwd), target);
    }
    const next = [...byKey.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const previous = previousTargetsRef.current;
    if (
      previous.length === next.length &&
      previous.every(([key], index) => key === next[index]![0])
    ) {
      return previous;
    }
    previousTargetsRef.current = next;
    return next;
  }, [targets]);

  const statusesAtom = useMemo(() => {
    if (dedupedTargets.length === 0) {
      return EMPTY_STATUSES_ATOM;
    }
    return Atom.make(
      (get): ReadonlyMap<string, VcsStatusResult | null> =>
        new Map(
          dedupedTargets.map(([key, target]) => [
            key,
            Option.getOrNull(
              AsyncResult.value(
                get(
                  vcsEnvironment.status({
                    environmentId: target.environmentId,
                    input: { cwd: target.cwd },
                  }),
                ),
              ),
            ),
          ]),
        ),
    ).pipe(Atom.withLabel(`web:board-vcs-statuses:${dedupedTargets.length}`));
  }, [dedupedTargets]);

  return useAtomValue(statusesAtom);
}
