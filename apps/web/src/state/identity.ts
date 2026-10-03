import { createIdentityEnvironmentAtoms } from "@t3tools/client-runtime/state/identity";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const identityEnvironment = createIdentityEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_CLAIM_INPUT = {} as const;

/**
 * Session claim personId per connected environment.
 *
 * Ownership filters must key by the *thread's* environment, not primary.
 * Desktop primary=smart (no map) while secondary=t3vm (claimed) must still
 * Mine-filter t3vm threads correctly.
 */
export const identityClaimPersonIdByEnvironmentAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const out = new Map<string, string | null>();
  for (const environmentId of catalog.entries.keys()) {
    const result = get(
      identityEnvironment.sessionClaim({
        environmentId: environmentId as EnvironmentId,
        input: EMPTY_CLAIM_INPUT,
      }),
    );
    const claimResult = Option.getOrNull(AsyncResult.value(result));
    out.set(environmentId, claimResult?.claim?.personId ?? null);
  }
  return out;
}).pipe(Atom.withLabel("web-identity-claim-person-by-environment"));
