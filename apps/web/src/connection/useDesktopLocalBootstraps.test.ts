import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { bootstrapsEqual } from "./useDesktopLocalBootstraps";

const BOOTSTRAP: DesktopEnvironmentBootstrap = {
  id: "wsl:Ubuntu",
  label: "WSL: Ubuntu",
  runningDistro: "Ubuntu",
  httpBaseUrl: "http://127.0.0.1:4000",
  wsBaseUrl: "ws://127.0.0.1:4000",
  bootstrapToken: "token",
};

describe("desktop local bootstrap equality", () => {
  it("treats a re-read of an unchanged topology as equal", () => {
    // Each poll allocates a fresh array and fresh entries, so equality has to be
    // structural for the hook to keep the previous reference.
    expect(bootstrapsEqual([{ ...BOOTSTRAP }], [{ ...BOOTSTRAP }])).toBe(true);
    expect(bootstrapsEqual([], [])).toBe(true);
  });

  it("detects a backend appearing or disappearing", () => {
    expect(bootstrapsEqual([], [BOOTSTRAP])).toBe(false);
    expect(bootstrapsEqual([BOOTSTRAP], [])).toBe(false);
  });

  it("detects a change in any reported field", () => {
    const changes: ReadonlyArray<Partial<DesktopEnvironmentBootstrap>> = [
      { id: "wsl:Debian" },
      { label: "WSL: Debian" },
      { runningDistro: "Debian" },
      { httpBaseUrl: "http://127.0.0.1:4001" },
      { wsBaseUrl: "ws://127.0.0.1:4001" },
      { bootstrapToken: "rotated" },
    ];

    for (const change of changes) {
      expect(bootstrapsEqual([BOOTSTRAP], [{ ...BOOTSTRAP, ...change }])).toBe(false);
    }
  });

  it("detects a cold-booting backend gaining its URLs", () => {
    const cold: DesktopEnvironmentBootstrap = {
      ...BOOTSTRAP,
      httpBaseUrl: null,
      wsBaseUrl: null,
    };

    expect(bootstrapsEqual([cold], [BOOTSTRAP])).toBe(false);
  });
});
