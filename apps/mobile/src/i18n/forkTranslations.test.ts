import { initializeGT } from "gt-react-native";
import { describe, expect, it, vi } from "vite-plus/test";

import { SUPPORTED_LOCALES } from "./locales";

vi.mock("gt-react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react-native")>()),
  initializeGT: vi.fn(),
}));
vi.mock("react-native", () => ({}));
vi.mock("../state/preferences", () => ({}));

describe("fork translations", () => {
  it("loads fork strings alongside upstream's through the app's catalog loader", async () => {
    await import("./I18nProvider");
    const loadTranslations = vi.mocked(initializeGT).mock.calls[0]?.[0].loadTranslations;
    const catalog = Object.values(Object(await loadTranslations?.("de")));
    // The mobile ownership-filter title from the fork catalog, and upstream's "Side chat".
    expect(catalog).toContain("Zuständigkeit");
    expect(catalog).toContain("Nebenchat");
  });

  it("ships a fork catalog for every translated locale", async () => {
    const { withForkTranslations } = await import("./forkTranslations");
    const load = withForkTranslations(async () => ({}));
    for (const locale of SUPPORTED_LOCALES.filter((locale) => locale !== "en")) {
      expect(Object.keys(Object(await load(locale))).length, locale).toBeGreaterThan(0);
    }
  });
});
