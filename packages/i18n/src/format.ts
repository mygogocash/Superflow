import { DEFAULT_LOCALE, type Locale } from "./locales";

// Intl BCP-47 tag per app locale. Thai formatting (month names, grouping) uses
// th-TH; the Buddhist-era year is applied explicitly in formatDate so it does
// not depend on the runtime's ICU calendar data being complete.
const INTL_LOCALE: Record<Locale, string> = {
  en: "en-US",
  th: "th-TH",
};

/** Thai calendar year = Gregorian year + 543 (Buddhist Era). */
export const BUDDHIST_ERA_OFFSET = 543;

/** Convert a Gregorian year to the Thai Buddhist-Era year. Pure + testable. */
export function toBuddhistYear(gregorianYear: number): number {
  return gregorianYear + BUDDHIST_ERA_OFFSET;
}

export interface DateFormatOptions {
  /**
   * Render the year in the Buddhist Era. Defaults to true for Thai (the
   * everyday Thai convention) and false otherwise. Callers rendering statutory
   * documents can force either era regardless of locale.
   */
  buddhistEra?: boolean;
  /** IANA timezone. Defaults to Asia/Bangkok to match the rest of the app. */
  timeZone?: string;
  month?: "long" | "short" | "numeric" | "2-digit";
}

/**
 * Locale-aware long date. For Thai it renders Thai month names and, by default,
 * the Buddhist-Era year (Gregorian + 543) — computed explicitly so the output
 * is deterministic across runtimes rather than relying on the `-u-ca-buddhist`
 * calendar being present in ICU. Latin digits are forced so the year stays
 * machine-parseable.
 */
export function formatDate(
  date: Date,
  locale: Locale = DEFAULT_LOCALE,
  options: DateFormatOptions = {},
): string {
  const timeZone = options.timeZone ?? "Asia/Bangkok";
  const month = options.month ?? "long";
  const useBuddhistEra = options.buddhistEra ?? locale === "th";

  const parts = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    year: "numeric",
    month,
    day: "numeric",
    timeZone,
    numberingSystem: "latn",
    // Force Gregorian: th-TH defaults to the Buddhist calendar in ICU, which
    // would already return the BE year — applying our +543 on top would double
    // it. We take the Gregorian year and add the offset ourselves so the result
    // is identical regardless of the runtime's default Thai calendar.
    calendar: "gregory",
  }).formatToParts(date);

  return parts
    .map((part) => {
      if (part.type === "year" && useBuddhistEra) {
        const gregorian = Number(part.value);
        return Number.isFinite(gregorian)
          ? String(toBuddhistYear(gregorian))
          : part.value;
      }
      return part.value;
    })
    .join("");
}

/** Locale-aware number formatting (grouping separators, etc.). */
export function formatNumber(
  value: number,
  locale: Locale = DEFAULT_LOCALE,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    numberingSystem: "latn",
    ...options,
  }).format(value);
}

/** Locale-aware currency formatting, e.g. formatCurrency(1000, "THB", "th"). */
export function formatCurrency(
  value: number,
  currency: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return formatNumber(value, locale, { style: "currency", currency });
}
