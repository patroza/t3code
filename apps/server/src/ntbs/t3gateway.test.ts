import { describe, it } from "@effect/vitest";

describe("T3Gateway", () => {
  describe("planCoordinates", () => {
    describe("successful planning", () => {
      it.todo("pins the selected branch to the commit fetched from origin");

      it.todo(
        "returns the project, branch and commit with distinct thread and message IDs and a worktree branch derived from the thread ID",
      );
    });

    describe("rejected planning", () => {
      it.todo("rejects a project that does not exist without performing provisioning work");

      it.todo(
        "rejects a selected branch that is absent after a successful fetch without performing provisioning work",
      );
    });

    describe("operational failures", () => {
      it.todo("fails retryably when the project lookup fails");

      it.todo("fails retryably when fetching origin fails");

      it.todo("fails retryably when resolving the fetched branch fails operationally");

      it.todo("fails retryably when the exchange IDs cannot be minted");
    });
  });
});
