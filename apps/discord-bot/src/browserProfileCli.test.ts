import { describe, expect, it } from "vite-plus/test";

import { parseArguments } from "./browserProfileCli.ts";

describe("browser profile CLI arguments", () => {
  it("parses flags for profile-less commands", () => {
    const parsed = parseArguments(["list", "--data-dir", "/tmp/profiles"]);
    expect(parsed.command).toBe("list");
    expect(parsed.profile).toBeUndefined();
    expect(parsed.options.get("data-dir")).toBe("/tmp/profiles");
  });

  it("parses a profile followed by flags", () => {
    const parsed = parseArguments(["verify", "github-work", "--executable-path", "/bin/chrome"]);
    expect(parsed.profile).toBe("github-work");
    expect(parsed.options.get("executable-path")).toBe("/bin/chrome");
  });
});
