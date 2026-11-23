import { RelayConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveRemoteOpenState } from "./remoteOpen";

const target = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-server"),
  label: "smart",
});
const SMART = [
  { kind: "tailscale", host: "smart.tail1234.ts.net", username: "patroza" },
  { kind: "mdns", host: "smart.local", username: "patroza" },
] as const;

describe("same-machine server open", () => {
  it.each([
    {
      name: "desktop beside a server on this machine",
      desktop: true,
      host: SMART,
      mode: "local-exec",
    },
    {
      name: "desktop beside a server elsewhere",
      desktop: true,
      host: [{ kind: "mdns", host: "laptop.local", username: "patroza" }] as const,
      mode: "remote-links",
    },
    {
      name: "browser, whose host is not the viewing machine",
      desktop: false,
      host: SMART,
      mode: "remote-links",
    },
    {
      name: "desktop whose backend advertises nothing",
      desktop: true,
      host: undefined,
      mode: "remote-links",
    },
  ])("$name → $mode", ({ desktop, host, mode }) => {
    expect(
      resolveRemoteOpenState({
        target,
        sshTarget: null,
        isDesktopRenderer: desktop,
        remoteOpenTargets: SMART,
        hostEnvironmentId: "environment-desktop",
        hostRemoteOpenTargets: host,
      }).mode,
    ).toBe(mode);
  });
});
