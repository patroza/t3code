import { describe, expect, it } from "vite-plus/test";

import { buildWebThreadUrl, formatWebThreadOpenLink } from "./webThreadUrl.ts";

describe("buildWebThreadUrl", () => {
  it("builds the Discord thread URL", () => {
    expect(buildWebThreadUrl("https://omega.example/", "thread-1")).toBe(
      "https://omega.example/?thread=thread-1",
    );
    expect(buildWebThreadUrl("https://omega.example///", " thread-1 ")).toBe(
      "https://omega.example/?thread=thread-1",
    );
  });

  it("keeps a configured path prefix", () => {
    expect(buildWebThreadUrl("https://public.example.test/t3/", "tid-1")).toBe(
      "https://public.example.test/t3/?thread=tid-1",
    );
  });

  it("omits the link when the base or thread id is missing", () => {
    expect(buildWebThreadUrl(undefined, "thread-1")).toBeNull();
    expect(buildWebThreadUrl("  ", "thread-1")).toBeNull();
    expect(buildWebThreadUrl("https://omega.example", "  ")).toBeNull();
    expect(buildWebThreadUrl(null, null)).toBeNull();
  });

  it("uses the Open label Discord posts", () => {
    expect(formatWebThreadOpenLink("https://omega.example/?thread=thread-1")).toBe(
      "[Open](https://omega.example/?thread=thread-1)",
    );
  });
});
