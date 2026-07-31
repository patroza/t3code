import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";

import { resolveDesktopBackendPortHint } from "./DesktopApp.ts";

describe("resolveDesktopBackendPortHint", () => {
  it("keeps the renderer protocol aligned with a reused live backend", () => {
    expect(resolveDesktopBackendPortHint("http://127.0.0.1:8080/", Option.some(3773))).toEqual(
      Option.some(8080),
    );
  });

  it("uses the configured port when no live backend exists", () => {
    expect(resolveDesktopBackendPortHint(undefined, Option.some(4949))).toEqual(Option.some(4949));
  });

  it("ignores a malformed live backend marker", () => {
    expect(resolveDesktopBackendPortHint("not a URL", Option.some(4949))).toEqual(
      Option.some(4949),
    );
  });
});
