import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { environmentSnapshotAtom } from "./shell";

export const threadEnvironment = createThreadEnvironmentAtoms(connectionAtomRuntime);
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("mobile-environment-thread:empty"),
);

/** Keep the last selected thread detail stream mounted so reopen/back-nav is warm. */
let warmThreadUnmount: (() => void) | null = null;
const pressPrefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();

function threadPrefetchKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}\u0000${threadId}`;
}

/**
 * Start loading thread detail (SQLite → HTTP snapshot → WS resume) before the
 * Thread route mounts. Call from list press-in / selection so open latency
 * overlaps the navigation transition.
 */
export function prefetchEnvironmentThread(environmentId: EnvironmentId, threadId: ThreadId): void {
  const key = threadPrefetchKey(environmentId, threadId);
  const existingTimer = pressPrefetchTimers.get(key);
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
  }
  // Mount kicks off makeEnvironmentThreadState. Hold briefly so navigate can
  // attach useAtomValue; the Thread screen then keeps the same atom alive.
  const unmount = appAtomRegistry.mount(environmentThreads.stateAtom(environmentId, threadId));
  const timer = setTimeout(() => {
    pressPrefetchTimers.delete(key);
    unmount();
  }, 15_000);
  pressPrefetchTimers.set(key, timer);
}

/**
 * Hold the selected thread's detail atom mounted while the user stays in the
 * app session, so returning from the list does not re-run a cold full hydrate.
 * Replaces any previous warm hold.
 */
export function warmSelectedEnvironmentThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): void {
  const atom = environmentThreads.stateAtom(environmentId, threadId);
  const nextUnmount = appAtomRegistry.mount(atom);
  const previous = warmThreadUnmount;
  warmThreadUnmount = nextUnmount;
  previous?.();
}

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  return Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
}
