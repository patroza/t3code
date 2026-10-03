import { describe, expect, it } from "vite-plus/test";

import { threadWebUrl } from "./threadWebUrl.ts";

describe("threadWebUrl", () => {
  it("opens a thread through the connected environment web origin", () => {
    expect(
      threadWebUrl(
        "https://t3vm.tail86038f.ts.net/api/orchestration?ignored=yes#old",
        "efdbe462-3d2c-43d6-b18e-0b27b8df3836",
      ),
    ).toBe("https://t3vm.tail86038f.ts.net/?thread=efdbe462-3d2c-43d6-b18e-0b27b8df3836");
  });

  it("preserves a proxy origin while replacing its route", () => {
    expect(threadWebUrl("https://proxy.example.test/t3/", "thread/id")).toBe(
      "https://proxy.example.test/?thread=thread%2Fid",
    );
  });
});
