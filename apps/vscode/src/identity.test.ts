import { describe, expect, it } from "vite-plus/test";

import { filterIdentityPeople } from "./identity.ts";

const people = [
  { personId: "patroza", username: "patroza", name: "Patrick" },
  { personId: "joshua", username: "joshuadima", name: "Joshua" },
];

describe("filterIdentityPeople", () => {
  it("does not disclose the roster before three characters", () => {
    expect(filterIdentityPeople(people, "pa")).toEqual([]);
  });

  it("matches usernames and names case-insensitively", () => {
    expect(filterIdentityPeople(people, "PAT")).toEqual([people[0]]);
    expect(filterIdentityPeople(people, "shu")).toEqual([people[1]]);
  });
});
