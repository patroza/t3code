import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

describe("t3code/no-unsupported-hermes-array-methods", () => {
  const mobileRule = createOxlintRuleHarness("t3code/no-unsupported-hermes-array-methods", {
    filename: "apps/mobile/src/fixture.ts",
  });
  const sharedRule = createOxlintRuleHarness("t3code/no-unsupported-hermes-array-methods", {
    filename: "packages/shared/src/fixture.ts",
  });
  const webRule = createOxlintRuleHarness("t3code/no-unsupported-hermes-array-methods", {
    filename: "apps/web/src/fixture.ts",
  });

  mobileRule.invalid(
    "reports toSorted in mobile code",
    "export const sorted = [3, 1, 2].toSorted();",
    (output) => {
      assert.match(output, /Hermes does not provide Array\.prototype\.toSorted/);
    },
  );

  sharedRule.invalid(
    "reports toReversed in shared runtime code",
    "export const reversed = [1, 2, 3].toReversed();",
  );

  mobileRule.valid(
    "allows copy then sort in mobile code",
    "export const sorted = [...[3, 1, 2]].sort();",
  );

  webRule.valid(
    "does not constrain browser-only code",
    "export const sorted = [3, 1, 2].toSorted();",
  );
});
