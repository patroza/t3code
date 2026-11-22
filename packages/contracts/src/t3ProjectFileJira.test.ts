import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { T3ProjectFile } from "./t3ProjectFile.ts";

const decode = Schema.decodeUnknownSync(T3ProjectFile);

describe("T3ProjectFile jiraProjects", () => {
  it("decodes several Jira project keys and rejects a token that is not a key", () => {
    expect(decode({ jiraProjects: [" sa ", "CFG"] }).jiraProjects).toEqual(["SA", "CFG"]);
    expect(decode({ jiraProjects: [] }).jiraProjects).toEqual([]);
    expect(() => decode({ jiraProjects: ["SA-465"] })).toThrow();
    expect(() => decode({ jiraProjects: ["G"] })).toThrow();
    expect(() => decode({ jiraProjects: "SA" })).toThrow();
  });
});
