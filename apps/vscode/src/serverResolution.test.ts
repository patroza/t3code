import { describe, expect, it } from "vite-plus/test";

import { bearerTokenAppliesTo, serverCandidates } from "./serverResolution.ts";

describe("serverCandidates", () => {
  it("prefers the backend advertised by the local desktop runtime", () => {
    expect(serverCandidates("http://127.0.0.1:3773", "http://127.0.0.1:8080")).toEqual([
      { source: "desktop", url: "http://127.0.0.1:3773/" },
      { source: "configured", url: "http://127.0.0.1:8080/" },
    ]);
  });

  it("deduplicates equivalent desktop and configured URLs", () => {
    expect(serverCandidates("http://127.0.0.1:3773", "http://127.0.0.1:3773/")).toEqual([
      { source: "desktop", url: "http://127.0.0.1:3773/" },
    ]);
  });

  it("uses the configured URL when no desktop runtime is advertised", () => {
    expect(serverCandidates(null, "http://remote.example:8080")).toEqual([
      { source: "configured", url: "http://remote.example:8080/" },
    ]);
  });
});

describe("paired endpoint candidates", () => {
  it("tries the paired endpoint before desktop and configured ones", () => {
    expect(
      serverCandidates("http://127.0.0.1:3773", "http://127.0.0.1:8080", "http://paired.example"),
    ).toEqual([
      { source: "paired", url: "http://paired.example/" },
      { source: "desktop", url: "http://127.0.0.1:3773/" },
      { source: "configured", url: "http://127.0.0.1:8080/" },
    ]);
  });

  it("does not list the paired endpoint twice when it is also the desktop one", () => {
    expect(
      serverCandidates("http://127.0.0.1:3773", "http://127.0.0.1:8080", "http://127.0.0.1:3773/"),
    ).toEqual([
      { source: "paired", url: "http://127.0.0.1:3773/" },
      { source: "configured", url: "http://127.0.0.1:8080/" },
    ]);
  });

  it("is unchanged when nothing is paired", () => {
    expect(serverCandidates("http://127.0.0.1:3773", "http://127.0.0.1:8080", null)).toEqual(
      serverCandidates("http://127.0.0.1:3773", "http://127.0.0.1:8080"),
    );
  });
});

describe("bearerTokenAppliesTo", () => {
  it("keeps a paired token away from every server but its issuer", () => {
    // Pairing with B must not disclose B's token to the desktop or configured
    // server A, which is what an unscoped token would do on the first candidate.
    expect(bearerTokenAppliesTo("http://server-b.example", "http://server-a.example")).toBe(false);
    expect(bearerTokenAppliesTo("http://server-b.example", "http://server-b.example")).toBe(true);
  });

  it("compares endpoints after normalisation rather than as raw strings", () => {
    expect(bearerTokenAppliesTo("http://server-b.example", "http://server-b.example/")).toBe(true);
  });

  it("leaves hand-entered and pre-pinning tokens unscoped", () => {
    expect(bearerTokenAppliesTo(null, "http://anything.example")).toBe(true);
    expect(bearerTokenAppliesTo("", "http://anything.example")).toBe(true);
  });
});
