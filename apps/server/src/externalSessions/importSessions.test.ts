import { assert, describe, it } from "@effect/vitest";

import { formatImportSessionsResults, type ImportSessionsResult } from "./importSessions.ts";

const result: ImportSessionsResult = {
  provider: "codex",
  id: "session-1",
  title: "Imported session",
  cwd: "/workspace/project",
  status: "dry-run",
};

describe("formatImportSessionsResults", () => {
  it("formats human-readable CLI output", () => {
    assert.strictEqual(
      formatImportSessionsResults([result], { json: false }),
      "dry-run\tcodex\tsession-1\tImported session",
    );
  });

  it("formats machine-readable JSON output", () => {
    assert.deepStrictEqual(JSON.parse(formatImportSessionsResults([result], { json: true })), [
      result,
    ]);
  });
});
