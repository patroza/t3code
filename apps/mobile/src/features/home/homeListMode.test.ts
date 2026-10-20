import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_HOME_THREAD_GROUPING,
  isHomeThreadGrouping,
  resolveHomeThreadGrouping,
} from "./homeListMode";

describe("home thread grouping", () => {
  it("validates recency / project / none", () => {
    expect(isHomeThreadGrouping("recency")).toBe(true);
    expect(isHomeThreadGrouping("project")).toBe(true);
    expect(isHomeThreadGrouping("none")).toBe(true);
    expect(isHomeThreadGrouping("recent")).toBe(false);
    expect(isHomeThreadGrouping(undefined)).toBe(false);
  });

  it("resolves stored values and defaults when unset", () => {
    expect(resolveHomeThreadGrouping(undefined)).toBe(DEFAULT_HOME_THREAD_GROUPING);
    expect(resolveHomeThreadGrouping("bogus")).toBe("project");
    expect(resolveHomeThreadGrouping("recency")).toBe("recency");
    expect(resolveHomeThreadGrouping("none")).toBe("none");
    expect(resolveHomeThreadGrouping("project")).toBe("project");
  });
});
