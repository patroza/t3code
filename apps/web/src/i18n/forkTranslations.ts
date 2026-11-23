import { DEFAULT_LOCALE } from "./locales";

type LoadTranslations = (locale: string) => Promise<unknown>;

// Fork strings ship in their own catalogs (scripts/fork-i18n.ts) so upstream's stay untouched.
async function loadForkTranslations(locale: string): Promise<unknown> {
  if (locale === DEFAULT_LOCALE) return {};
  const module: { default: unknown } = await import(`./fork-translations/${locale}.json`);
  return module.default;
}

/** Adds the fork catalog to each locale upstream's loader returns. */
export const withForkTranslations =
  (load: LoadTranslations): LoadTranslations =>
  async (locale) => {
    const [upstream, fork] = await Promise.all([load(locale), loadForkTranslations(locale)]);
    return Object.assign({}, upstream, fork);
  };
