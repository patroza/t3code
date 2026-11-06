import { describe, expect, it } from "vite-plus/test";

import { unmanagedUpdatePolicy } from "./DesktopUpdatePolicy.ts";
import { getAutoUpdateDisabledReason } from "./DesktopUpdates.ts";

const packaged = {
  policy: unmanagedUpdatePolicy,
  isDevelopment: false,
  isPackaged: true,
  appImage: undefined,
  isDebPackage: false,
  disabledByEnv: false,
  hasUpdateFeedConfig: false,
} as const;

describe("getAutoUpdateDisabledReason", () => {
  it("enables a Windows directory deploy that has no update feed", () => {
    expect(
      getAutoUpdateDisabledReason({
        ...packaged,
        platform: "win32",
        isDirInstall: true,
      }),
    ).toBeNull();
  });

  it("still requires a feed for a Windows install that is not a directory deploy", () => {
    expect(
      getAutoUpdateDisabledReason({
        ...packaged,
        platform: "win32",
        isDirInstall: false,
      }),
    ).toBe("Automatic updates are not available because no update feed is configured.");
  });

  it("enables a Linux directory deploy that has no update feed", () => {
    expect(
      getAutoUpdateDisabledReason({
        ...packaged,
        platform: "linux",
        isDirInstall: true,
      }),
    ).toBeNull();
  });

  it("keeps a managed policy that turns updates off ahead of directory detection", () => {
    expect(
      getAutoUpdateDisabledReason({
        ...packaged,
        platform: "win32",
        isDirInstall: true,
        policy: {
          ...unmanagedUpdatePolicy,
          mode: "off",
          message: "Updates are turned off.",
        },
      }),
    ).toBe("Updates are turned off.");
  });
});
