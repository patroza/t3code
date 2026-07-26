import { describe, expect, it } from "vite-plus/test";

import { serverCandidates } from "./serverResolution.ts";

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
