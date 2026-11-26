/** Talen van het panel. Standaard Engels; de keuze staat in de cookie `panel_locale`. */
export const LOCALES = ["en", "nl"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "panel_locale";
export const LOCALE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** Cookiewaarde → taal; alles behalve "nl" wordt Engels (niet de browsertaal). */
export function parseLocale(v: string | null | undefined): Locale {
  return v === "nl" ? "nl" : "en";
}

/** Locale voor Intl (datums, getallen). */
export const INTL_LOCALE: Record<Locale, string> = { en: "en-GB", nl: "nl-NL" };
