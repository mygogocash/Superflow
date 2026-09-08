// The set of locales the product ships translations for. Adding a locale here
// is the single switch that makes it selectable everywhere (web + Expo + API),
// so a new language is a catalog addition, not a code change across surfaces.
export const SUPPORTED_LOCALES = ["en", "th"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Fallback locale used when nothing else resolves. */
export const DEFAULT_LOCALE: Locale = "en";

/** Native-name labels for a language switcher (shown in each language itself). */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  th: "ไทย",
};

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Resolve a locale from a prioritized list of candidates — the intended chain
 * is `user.locale → app.locale (org default) → Accept-Language/navigator`. Each
 * candidate may be a full BCP-47 tag (e.g. "th-TH"); only the primary subtag is
 * matched, so "th-TH" and "th" both resolve to "th". The first supported hit
 * wins; if none match, `DEFAULT_LOCALE`.
 */
export function resolveLocale(
  ...candidates: Array<string | null | undefined>
): Locale {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const primary = candidate.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}
