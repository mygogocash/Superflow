import {
  buildI18nResources,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
} from "@nexora/i18n";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

// Single isomorphic i18next instance. Resources are bundled (no async backend),
// so init is synchronous and `useTranslation` returns real text during SSR —
// the first paint is DEFAULT_LOCALE on both server and client, avoiding a
// hydration mismatch. The client switches language after mount (see
// I18nProvider) if the user's stored preference differs.
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources: buildI18nResources(),
    lng: DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

export default i18next;
