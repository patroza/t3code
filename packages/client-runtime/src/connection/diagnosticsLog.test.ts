import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  CONNECTION_DIAGNOSTICS_STORAGE_KEY,
  clearConnectionDiagnosticsForTests,
  layer,
  ConnectionDiagnosticsLog,
} from "./diagnosticsLog.ts";

describe("ConnectionDiagnosticsLog", () => {
  it.effect("records events and prunes entries older than the retention window", () =>
    Effect.gen(function* () {
      clearConnectionDiagnosticsForTests();
      const log = yield* ConnectionDiagnosticsLog;
      const now = yield* DateTime.now;
      const staleAt = DateTime.formatIso(DateTime.subtract(now, { hours: 13 }));
      const freshAt = DateTime.formatIso(now);

      yield* log.record({
        at: staleAt,
        environmentId: "env-old",
        label: "old",
        kind: "disconnect",
        reason: "transport",
        detail: "old disconnect",
      });
      yield* log.record({
        at: freshAt,
        environmentId: "env-new",
        label: "t3vm",
        kind: "disconnect",
        reason: "transport",
        detail: "t3vm closed (1006 abnormal).",
        closeCode: 1006,
        socketHost: "198.18.83.2:3773",
      });

      const events = yield* log.list;
      expect(events.map((event) => event.environmentId)).toEqual(["env-new"]);
      expect(events[0]?.detail).toContain("1006");
      expect(events[0]?.socketHost).toBe("198.18.83.2:3773");

      if (typeof globalThis.localStorage !== "undefined") {
        const raw = globalThis.localStorage.getItem(CONNECTION_DIAGNOSTICS_STORAGE_KEY);
        expect(raw).toContain("env-new");
        expect(raw).not.toContain("env-old");
      }
    }).pipe(Effect.provide(layer)),
  );
});
