// Fork strings ship in their own catalogs (scripts/fork-i18n.ts) so upstream's stay untouched.
// Required on demand, like upstream's: Metro runs every statically imported module at startup.
const FORK_CATALOGS: Readonly<Record<string, () => unknown>> = {
  es: () => require("./fork-translations/es.json"),
  zh: () => require("./fork-translations/zh.json"),
  "pt-BR": () => require("./fork-translations/pt-BR.json"),
  fr: () => require("./fork-translations/fr.json"),
  de: () => require("./fork-translations/de.json"),
  ja: () => require("./fork-translations/ja.json"),
  ko: () => require("./fork-translations/ko.json"),
  ru: () => require("./fork-translations/ru.json"),
  sv: () => require("./fork-translations/sv.json"),
};

type LoadTranslations = (locale: string) => Promise<unknown>;

/** Adds the fork catalog to each locale upstream's loader returns. */
export const withForkTranslations =
  (load: LoadTranslations): LoadTranslations =>
  async (locale) =>
    Object.assign({}, await load(locale), FORK_CATALOGS[locale]?.());
