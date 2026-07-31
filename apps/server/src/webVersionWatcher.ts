// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { resolveStaticDir } from "./config.ts";
import type { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";

/** How often to re-read the served index.html to detect an on-disk asset swap. */
const POLL_INTERVAL = Duration.seconds(10);

/**
 * Identity of the currently served web bundle: a hash of index.html. Returns
 * null when no static bundle is present (e.g. the dev server proxies Vite
 * instead of serving files), in which case there is nothing to watch.
 */
const readWebVersion = (staticDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const data = yield* fs
      .readFile(path.join(staticDir, "index.html"))
      .pipe(Effect.orElseSucceed(() => null));
    return data === null ? null : NodeCrypto.createHash("sha1").update(data).digest("hex");
  });

/**
 * Broadcasts a `webVersionChanged` lifecycle event whenever the served
 * index.html changes on disk, so connected clients learn that the web bundle
 * was hot-swapped underneath them and can offer a reload. The current version
 * is published once at startup to seed the lifecycle snapshot, so a client
 * that connects later learns the version it is actually running. No-op when
 * there is no packaged bundle to serve.
 *
 * Intended to be run with `Effect.forkScoped`; the poll loop never returns.
 */
export const runWebVersionWatcher = (lifecycleEvents: ServerLifecycleEvents["Service"]) =>
  Effect.gen(function* () {
    const staticDir = yield* resolveStaticDir();
    if (staticDir === undefined) {
      return;
    }
    const initial = yield* readWebVersion(staticDir);
    const lastRef = yield* Ref.make(initial);
    if (initial !== null) {
      yield* lifecycleEvents.publish({
        version: 1,
        type: "webVersionChanged",
        payload: { webVersion: initial },
      });
    }
    return yield* Effect.gen(function* () {
      const current = yield* readWebVersion(staticDir);
      const last = yield* Ref.get(lastRef);
      if (current !== null && current !== last) {
        yield* Ref.set(lastRef, current);
        yield* lifecycleEvents.publish({
          version: 1,
          type: "webVersionChanged",
          payload: { webVersion: current },
        });
      }
    }).pipe(Effect.delay(POLL_INTERVAL), Effect.forever);
  });
