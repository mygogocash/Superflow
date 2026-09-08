import { en, type Messages } from "./en";
import { th } from "./th";

import type { Locale } from "../locales";

export type { Messages };
export { en, th };

/** All catalogs keyed by locale — the source for each app's i18next resources. */
export const messages: Record<Locale, Messages> = { en, th };

/**
 * i18next-shaped resources: `{ [locale]: { translation: <catalog> } }`. Each
 * app initializes its own i18next instance from this, so the two React
 * runtimes (web / Expo) never share an instance while sharing one catalog.
 */
export function buildI18nResources(): Record<Locale, { translation: Messages }> {
  return {
    en: { translation: en },
    th: { translation: th },
  };
}
