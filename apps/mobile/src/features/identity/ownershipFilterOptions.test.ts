import { describe, expect, it } from "vite-plus/test";

import { sanitizeOwnershipPreferences } from "./ownershipFilterOptions";

describe("sanitizeOwnershipPreferences", () => {
  it("keeps stored Mine/Theirs choices and drops unknown values", () => {
    expect(
      sanitizeOwnershipPreferences({ ownershipFilter: "theirs", ownershipRelation: "created" }),
    ).toEqual({ ownershipFilter: "theirs", ownershipRelation: "created" });
    expect(
      sanitizeOwnershipPreferences({
        ownershipFilter: "everyone",
        ownershipRelation: "owned",
      } as never),
    ).toEqual({});
  });
});
