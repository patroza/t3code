import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

import * as MacApplicationIcon from "./MacApplicationIcon.ts";

const { createFromBufferMock, getFileIconMock } = vi.hoisted(() => ({
  createFromBufferMock: vi.fn(),
  getFileIconMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getFileIcon: getFileIconMock },
  nativeImage: { createFromBuffer: createFromBufferMock },
}));

const applicationIconLayer = MacApplicationIcon.layer.pipe(Layer.provide(NodeServices.layer));

const provideLayer = <A, E>(effect: Effect.Effect<A, E, MacApplicationIcon.MacApplicationIcon>) =>
  effect.pipe(Effect.provide(applicationIconLayer));

describe("MacApplicationIcon", () => {
  beforeEach(() => {
    createFromBufferMock.mockReset();
    getFileIconMock.mockReset();
  });

  it.effect("falls back to Electron's system icon lookup", () =>
    provideLayer(
      Effect.gen(function* () {
        getFileIconMock.mockResolvedValue({ toDataURL: () => "data:image/png;base64,icon" });
        const applicationIcon = yield* MacApplicationIcon.MacApplicationIcon;

        assert.equal(
          yield* applicationIcon.resolveDataUrl("/missing/Fixture.app"),
          "data:image/png;base64,icon",
        );
        assert.deepEqual(getFileIconMock.mock.calls[0], [
          "/missing/Fixture.app",
          { size: "large" },
        ]);
      }),
    ),
  );

  it.effect("reports system icon lookup failures with the application path", () =>
    provideLayer(
      Effect.gen(function* () {
        getFileIconMock.mockRejectedValue(new Error("icon unavailable"));
        const applicationIcon = yield* MacApplicationIcon.MacApplicationIcon;

        const error = yield* Effect.flip(applicationIcon.resolveDataUrl("/missing/Fixture.app"));
        assert.equal(error._tag, "MacApplicationIconResolutionError");
        assert.equal(error.applicationPath, "/missing/Fixture.app");
      }),
    ),
  );
});
