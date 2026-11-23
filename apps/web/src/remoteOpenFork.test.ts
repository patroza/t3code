import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldShowOpenInPicker } from "./components/chat/OpenInPicker.logic";
import { resolveRemoteOpenState } from "./remoteOpen";

const target = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-server"),
  label: "smart",
  connectionId: "saved-smart",
});

describe("paired environment open over its active route", () => {
  it.each([
    { url: "http://localhost:8080/", mode: "local-exec" },
    { url: "http://127.0.0.1:8080/", mode: "local-exec" },
    { url: "http://[::1]:8080/", mode: "local-exec" },
    { url: "https://smart.tail1234.ts.net:8443/", mode: "remote-links" },
    { url: "http://100.79.59.91:8080/", mode: "remote-links" },
    { url: undefined, mode: "remote-links" },
  ])("$url → $mode", ({ url, mode }) => {
    expect(
      resolveRemoteOpenState({
        target,
        routes: [],
        isDesktopRenderer: true,
        remoteOpenTargets: [{ kind: "tailscale", host: "smart.tail1234.ts.net" }],
        hostEnvironmentId: "environment-desktop",
        activeHttpBaseUrl: url,
      }).mode,
    ).toBe(mode);
  });
});

describe("Open in for a paired environment that opens locally", () => {
  it.each([
    { reachedOverLoopback: true, shown: true },
    { reachedOverLoopback: false, shown: false },
  ])("loopback $reachedOverLoopback → shown $shown", ({ reachedOverLoopback, shown }) => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "t3code",
        activeThreadEnvironmentId: EnvironmentId.make("environment-server"),
        primaryEnvironmentId: EnvironmentId.make("environment-desktop"),
        hostEnvironmentId: "environment-desktop",
        remoteOpenMode: "local-exec",
        reachedOverLoopback,
      }),
    ).toBe(shown);
  });
});
