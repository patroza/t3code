import { describe, expect, it } from "vite-plus/test";

import {
  isAllEnvironmentsSelected,
  isEnvironmentSelected,
  matchesEnvironmentFilter,
  resolveSelectedEnvironmentIds,
  toggleEnvironmentId,
} from "./homeEnvironmentFilter";

const envA = "env-a" as never;
const envB = "env-b" as never;
const envC = "env-c" as never;

describe("homeEnvironmentFilter", () => {
  it("treats empty selection as all environments", () => {
    expect(isAllEnvironmentsSelected([])).toBe(true);
    expect(matchesEnvironmentFilter(envA, [])).toBe(true);
    expect(isEnvironmentSelected([], envA)).toBe(true);
  });

  it("restricts matches to the selected set", () => {
    expect(matchesEnvironmentFilter(envA, [envA, envB])).toBe(true);
    expect(matchesEnvironmentFilter(envC, [envA, envB])).toBe(false);
    expect(isEnvironmentSelected([envA], envA)).toBe(true);
    expect(isEnvironmentSelected([envA], envB)).toBe(false);
  });

  it("toggles from all → singleton → multi → all", () => {
    expect(toggleEnvironmentId([], envA)).toEqual([envA]);
    expect(toggleEnvironmentId([envA], envB)).toEqual([envA, envB]);
    expect(toggleEnvironmentId([envA, envB], envA)).toEqual([envB]);
    expect(toggleEnvironmentId([envB], envB)).toEqual([]);
  });

  it("drops unavailable environment ids", () => {
    const available = new Set([envA, envB]);
    expect(resolveSelectedEnvironmentIds([envA, envC], available)).toEqual([envA]);
    expect(resolveSelectedEnvironmentIds([], available)).toEqual([]);
  });
});
