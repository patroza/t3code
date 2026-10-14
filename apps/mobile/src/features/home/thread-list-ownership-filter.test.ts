import { describe, expect, it, vi } from "vite-plus/test";

import {
  ownershipFilterChipLabel,
  ownershipFilterIsCustom,
  ownershipFilterMenuActions,
  selectOwnershipFilterMenuAction,
} from "./thread-list-ownership-filter";

describe("ownership list filter chip", () => {
  it("labels the default as Mine and names a narrowed relation", () => {
    expect(ownershipFilterChipLabel("mine", "both")).toBe("Mine");
    expect(ownershipFilterChipLabel("theirs", "created")).toBe("Theirs · Created");
    expect(ownershipFilterIsCustom("mine", "both")).toBe(false);
    expect(ownershipFilterIsCustom("any", "both")).toBe(true);
    expect(ownershipFilterIsCustom("mine", "participated")).toBe(true);
  });

  it("offers ownership, and includes only for Mine or Theirs", () => {
    const mine = ownershipFilterMenuActions("mine", "created");
    expect(mine.map((action) => action.title)).toEqual(["Ownership", "Mine includes"]);
    expect(mine[0]?.subactions?.find((action) => action.state === "on")?.title).toBe("Mine");
    expect(mine[1]?.subactions?.find((action) => action.state === "on")?.title).toBe("Created");

    const anyone = ownershipFilterMenuActions("any", "both");
    expect(anyone.map((action) => action.title)).toEqual(["Ownership"]);
    expect(ownershipFilterMenuActions("theirs", "both")[1]?.title).toBe("Theirs includes");
  });

  it("applies the selected ownership or includes choice", () => {
    const onOwnershipFilterChange = vi.fn();
    const onOwnershipRelationChange = vi.fn();
    const handlers = { onOwnershipFilterChange, onOwnershipRelationChange };

    selectOwnershipFilterMenuAction("ownership:theirs", handlers);
    selectOwnershipFilterMenuAction("relation:participated", handlers);
    selectOwnershipFilterMenuAction("ownership", handlers);
    selectOwnershipFilterMenuAction("relation:nope", handlers);

    expect(onOwnershipFilterChange).toHaveBeenCalledTimes(1);
    expect(onOwnershipFilterChange).toHaveBeenCalledWith("theirs");
    expect(onOwnershipRelationChange).toHaveBeenCalledTimes(1);
    expect(onOwnershipRelationChange).toHaveBeenCalledWith("participated");
  });
});
