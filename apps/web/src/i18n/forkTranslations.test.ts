import { initializeGTSPA } from "gt-react";
import { describe, expect, it, vi } from "vite-plus/test";

import { initializeI18n } from "./initializeI18n";

vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  initializeGTSPA: vi.fn(),
}));

describe("fork translations", () => {
  it("loads fork strings alongside upstream's through the app's catalog loader", async () => {
    initializeI18n(() => {});
    const loadTranslations = vi.mocked(initializeGTSPA).mock.calls[0]?.[0].loadTranslations;
    const catalog = Object.values(Object(await loadTranslations?.("de")));
    // An ownership-filter label from the fork catalog, and upstream's "Side chat".
    expect(catalog).toContain("Meine + nicht zugeordnete");
    expect(catalog).toContain("Nebenchat");
  });
});
