// Pool registry for multiple backend processes. This file is the entry
// point for the concurrent-Windows+WSL-backend feature; see the design
// notes below before extending it.
//
// Current state (step 3):
//   - `DesktopBackendManager.ts` no longer exposes a Context.Service. It
//     is a per-instance factory (`makeBackendInstance(spec)`); the pool
//     calls it once for the Windows primary at startup.
//   - The primary spec wires `configResolve` to `DesktopBackendConfiguration`
//     and the `onReady`/`onShutdown` callbacks to the window service's
//     `handleBackendReady` / `handleBackendNotReady`. Readiness is no
//     longer in `DesktopState`; the window owns its own latch.
//   - Consumers (window/wsl IPC, lifecycle hooks, telemetry) read the
//     primary instance off `pool.primary`. There is no longer a separate
//     `DesktopBackendManager` service in the layer graph.
//
// Target state (concurrent Windows + WSL):
//   - The pool layer constructs N instances — at minimum the Windows
//     primary; the WSL instance is added when the user enables the WSL
//     backend (with the selected distro).
//   - Per-instance state (readiness, restart fiber, active run) lives on
//     each `DesktopBackendInstance`. Step 3 splits backend log routing
//     per instance.
//   - `getLocalEnvironmentBootstrap()` widens to
//     `getLocalEnvironmentBootstraps()` returning one bootstrap per pool
//     instance; the frontend env runtime registers each as a local
//     environment.
//   - The WSL "swap" IPC is replaced by `enableWslBackend()` +
//     `setWslBackendDistro()` controlling which (if any) WSL instance the
//     pool holds. No more swap-mode, no more rollback-on-restart.
//
// Migration sequence (each step is its own commit):
//   1. Reshape `DesktopBackendManager` into an instance factory and route
//      consumers through the pool. Pool still holds a single instance.
//   2. Drop `DesktopState.backendReady`. The window owns its own
//      readiness latch, driven by the primary instance's onReady /
//      onShutdown callbacks.
//   3. (this commit) Per-instance log routing: replace the singleton
//      DesktopBackendOutputLog with a factory that vends one rotating
//      writer per instance id (primary keeps server-child.log; others go
//      to server-child-<sanitized-id>.log).
//   4. Add register/unregister so WSL backend can be added on demand.
//   5. Wire WSL distro startup through the pool; remove `setWslBackend`
//      mode-swap IPC in favor of `enableWslBackend` / `setWslDistro`.
//   6. Widen `getLocalEnvironmentBootstrap` → `*Bootstraps`; frontend
//      runtime registers each pool instance as a local environment.
//   7. Drop the swap dialog + the "mode" appSetting. Settings UI gets a
//      "WSL backend enabled + distro" pair instead.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export type BackendInstanceId = DesktopBackendManager.BackendInstanceId;
export const BackendInstanceId = DesktopBackendManager.BackendInstanceId;
export const PRIMARY_INSTANCE_ID = DesktopBackendManager.PRIMARY_INSTANCE_ID;
export type DesktopBackendInstance = DesktopBackendManager.DesktopBackendInstance;

export interface DesktopBackendPoolShape {
  // Look up a registered instance. None when no backend with that id is
  // currently registered (e.g. WSL backend disabled).
  readonly get: (id: BackendInstanceId) => Effect.Effect<Option.Option<DesktopBackendInstance>>;
  // Snapshot of all currently-registered instances. Order is unspecified;
  // callers that need a canonical "primary first" view should sort by id.
  readonly list: Effect.Effect<readonly DesktopBackendInstance[]>;
  // Convenience accessor for the always-registered primary instance.
  // Currently equivalent to `get(PRIMARY_INSTANCE_ID)` unwrapped, but
  // exposed as a typed effect so consumers don't have to handle the
  // Option for the case that's guaranteed to be present.
  readonly primary: Effect.Effect<DesktopBackendInstance>;
}

export class DesktopBackendPool extends Context.Service<
  DesktopBackendPool,
  DesktopBackendPoolShape
>()("t3/desktop/BackendPool") {}

export const layer = Layer.effect(
  DesktopBackendPool,
  Effect.gen(function* () {
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;

    const primary = yield* DesktopBackendManager.makeBackendInstance({
      id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
      label: "Windows",
      configResolve: configuration.resolve,
      // Window creation errors propagating out of handleBackendReady are
      // swallowed here on purpose: they're logged by the window service
      // and we don't want a stuck splash window to block the readiness
      // callback (which would prevent restartAttempt from being reset).
      onReady: () => desktopWindow.handleBackendReady.pipe(Effect.catch(() => Effect.void)),
      onShutdown: () => desktopWindow.handleBackendNotReady,
    });

    const instancesRef = yield* Ref.make<ReadonlyMap<BackendInstanceId, DesktopBackendInstance>>(
      new Map([[DesktopBackendManager.PRIMARY_INSTANCE_ID, primary]]),
    );

    return DesktopBackendPool.of({
      get: (id) =>
        Ref.get(instancesRef).pipe(
          Effect.map((instances) => Option.fromNullishOr(instances.get(id))),
        ),
      list: Ref.get(instancesRef).pipe(Effect.map((instances) => Array.from(instances.values()))),
      primary: Effect.succeed(primary),
    });
  }),
);

// Test layer for unit tests that want to assert against a known pool
// composition without standing up the full manager. Each provided
// instance is registered under its own id; the first one is also
// surfaced as `primary` so callers can stub a single-instance pool.
export const layerTest = (
  instances: readonly DesktopBackendInstance[],
): Layer.Layer<DesktopBackendPool> =>
  Layer.effect(
    DesktopBackendPool,
    Effect.gen(function* () {
      if (instances.length === 0) {
        return yield* Effect.die("DesktopBackendPool.layerTest requires at least one instance");
      }
      const byId = new Map<BackendInstanceId, DesktopBackendInstance>(
        instances.map((instance) => [instance.id, instance] as const),
      );
      const primary = instances[0]!;
      return DesktopBackendPool.of({
        get: (id) => Effect.succeed(Option.fromNullishOr(byId.get(id))),
        list: Effect.succeed(Array.from(byId.values())),
        primary: Effect.succeed(primary),
      });
    }),
  );
