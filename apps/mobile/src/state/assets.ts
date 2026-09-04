import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentConnectionPhase,
  presentConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  assetUrlStateFromResult,
  createAssetEnvironmentAtoms,
  EMPTY_ASSET_URL_ATOM,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { type AssetUrlState, deriveAssetUrlState } from "./asset-url-state";
import { usePreparedConnection } from "./session";
import { useAtomQueryRunner } from "./use-atom-query-runner";

export type { AssetUrlFailureReason, AssetUrlState } from "./asset-url-state";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_CONNECTION_STATE_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-asset-connection-state:empty"),
);

const EMPTY_ASSET_URLS_ATOM = Atom.make([] as Array<AsyncResult.AsyncResult<never, never>>).pipe(
  Atom.withLabel("mobile-asset-urls:empty"),
);

function useConnectionPhase(environmentId: EnvironmentId | null): EnvironmentConnectionPhase {
  const state = useAtomValue(
    environmentId === null
      ? EMPTY_CONNECTION_STATE_ATOM
      : environmentCatalog.stateAtom(environmentId),
  );
  const value = Option.getOrNull(AsyncResult.value(state));
  return value === null ? "available" : presentConnectionState(value).phase;
}

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const connectionPhase = useConnectionPhase(environmentId);
  const result = useAtomValue(
    environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  const shared = assetUrlStateFromResult(
    result,
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
  );
  return deriveAssetUrlState({
    connectionPhase,
    // A failure left over from an outage is re-queried as soon as the
    // connection returns. While that re-query is in flight it is not a verdict
    // on the file, so it reads as loading rather than a false "unavailable".
    shared: shared._tag === "Failure" && result.waiting ? { _tag: "Loading" } : shared,
  });
}

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const state = useAssetUrlState(environmentId, resource);
  return state._tag === "Success" ? state.url : null;
}

/**
 * Batch sibling of {@link useAssetUrl}, for a set of resources whose size is
 * only known at render time (a thread's attachments, say) and so cannot be
 * resolved with one hook call each.
 */
export function useAssetUrls(
  environmentId: EnvironmentId | null,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const results = useAtomValue(
    environmentId === null || resources.length === 0
      ? EMPTY_ASSET_URLS_ATOM
      : assetEnvironment.createUrls({ environmentId, resources }),
  );
  return useMemo(
    () =>
      preparedConnection._tag === "None"
        ? resources.map(() => null)
        : results.map((result) =>
            AsyncResult.isSuccess(result)
              ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
              : null,
          ),
    [preparedConnection, resources, results],
  );
}

/** Explicit playback and sharing must reauthorize files that may have been replaced on disk. */
export function useRefreshAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  return useCallback(async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const state = assetUrlStateFromResult(
      await createUrl({ environmentId, input: { resource } }),
      httpBaseUrl,
    );
    return state._tag === "Success" ? state.url : null;
  }, [createUrl, environmentId, httpBaseUrl, resource]);
}
