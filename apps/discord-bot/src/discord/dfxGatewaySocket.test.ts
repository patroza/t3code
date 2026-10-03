import * as NodeModule from "node:module";

import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);

describe("dfx Discord gateway Socket compat", () => {
  it("is 1.0.16+ so shards use writer.write, not writeRaw", () => {
    const version = (require("dfx/package.json") as { version: string }).version;
    const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
    // dfx 1.0.15 calls the Effect rc.115 writer as a function (`writeRaw is not
    // a function`) and the Discord gateway never IDENTIFYs. Mentions go silent
    // while REST (slash registration, rehydrate) still looks healthy.
    expect(major > 1 || (major === 1 && (minor > 0 || patch >= 16))).toBe(true);
  });
});
