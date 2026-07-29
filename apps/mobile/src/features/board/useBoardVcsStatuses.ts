import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo, useRef } from "react";

import { vcsEnvironment } from "../../state/vcs";
import { boardGitKey } from "./boardLogic";

export interface BoardVcsTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

const EMPTY_STATUSES_ATOM = Atom.make(
  (): ReadonlyMap<string, VcsStatusResult | null> => new Map(),
).pipe(Atom.withLabel("mobile:board-vcs-statuses:empty"));

/**
 * Aggregated list-mode VCS status for the board (no remote poller) — same
 * shape as web `useBoardVcsStatuses`.
 */
export function useBoardVcsStatuses(
  targets: ReadonlyArray<BoardVcsTarget>,
): ReadonlyMap<string, VcsStatusResult | null> {
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
                  vcsEnvironment.listStatus({
                    environmentId: target.environmentId,
                    input: { cwd: target.cwd },
                  }),
                ),
              ),
            ),
          ]),
        ),
    ).pipe(Atom.withLabel(`mobile:board-vcs-statuses:${dedupedTargets.length}`));
  }, [dedupedTargets]);

  return useAtomValue(statusesAtom);
}
