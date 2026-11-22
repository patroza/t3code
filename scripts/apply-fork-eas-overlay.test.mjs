import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";

import { applyForkEasOverlay } from "./apply-fork-eas-overlay.mjs";

it("adds the fork identity to base profiles only and merges the eas patch", () => {
  const eas = {
    build: {
      production: { env: { APP_VARIANT: "production" }, channel: "production" },
      testflight: { extends: "production", env: { T3CODE_MOBILE_VERSION: "3.0.0" } },
    },
    submit: { production: { ios: { ascAppId: "upstream" }, android: { track: "internal" } } },
  };
  const next = applyForkEasOverlay(eas, {
    env: { T3CODE_MOBILE_EXPO_OWNER: "fork", T3CODE_MOBILE_VERSION: "9.0.0" },
    eas: { submit: { production: { ios: { ascAppId: "fork" } } } },
  });
  expect(next.build.production.env).toEqual({
    APP_VARIANT: "production",
    T3CODE_MOBILE_EXPO_OWNER: "fork",
    T3CODE_MOBILE_VERSION: "9.0.0",
  });
  expect(next.build.testflight.env).toEqual({ T3CODE_MOBILE_VERSION: "3.0.0" });
  expect(next.submit.production).toEqual({
    ios: { ascAppId: "fork" },
    android: { track: "internal" },
  });
});

it("applies to the real eas.json without dropping upstream profiles", () => {
  const read = (path) => JSON.parse(NodeFS.readFileSync(new URL(path, import.meta.url), "utf8"));
  const eas = read("../apps/mobile/eas.json");
  const fork = read("../apps/mobile/eas.fork.json");
  const next = applyForkEasOverlay(eas, fork);
  expect(Object.keys(next.build)).toEqual(Object.keys(eas.build));
  expect(next.build.production.env).toMatchObject(fork.env);
  expect(next.submit.production.ios.ascAppId).toBe(fork.eas.submit.production.ios.ascAppId);
});
