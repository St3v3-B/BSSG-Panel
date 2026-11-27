"use client";
import * as React from "react";
import { createContext, Fragment, use, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_LOCALE, INTL_LOCALE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from "./config";
import { en, type Dict } from "./en";
import { nl } from "./nl";

export * from "./config";
export type { Dict };

export const DICTS: Record<Locale, Dict> = { en, nl };

interface Ctx {
  locale: Locale;
  t: Dict;
  setLocale: (l: Locale) => void;
}
const LocaleContext = createContext<Ctx>({ locale: DEFAULT_LOCALE, t: en, setLocale: () => {} });

const IS_SERVER = typeof window === "undefined";

// Taal voor hulpfuncties buiten React (errorText, formatDate, …).
// - Browser: één gebruiker, één taal; de provider zet `current` bij elke render en bij een wissel.
// - Server (SSR): renders van gelijktijdige requests lopen door elkaar (Suspense, streaming), dus een
//   module-variabele zou de taal van de ene request in de andere laten lekken. Daar lezen we de context van
//   de render die nu loopt; die is per request. Buiten een render (geen dispatcher) de standaardtaal.
let current: Locale = DEFAULT_LOCALE;

type Internals = { H?: unknown };
const reactInternals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: Internals })
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

function serverLocale(): Locale {
  // Zonder actieve dispatcher (niet tijdens een render) zou use() in dev een fout loggen en gooien.
  if (reactInternals && !reactInternals.H) return DEFAULT_LOCALE;
  try {
    return use(LocaleContext).locale;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export const getLocale = (): Locale => (IS_SERVER ? serverLocale() : current);
export const getT = (): Dict => DICTS[getLocale()];
export const intlLocale = () => INTL_LOCALE[getLocale()];

export function writeLocaleCookie(l: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
}

/**
 * Geeft de taal door. Bij een wissel worden de kinderen opnieuw gemount (key), zodat ook
 * hulpfuncties die getT() gebruiken de nieuwe taal tonen; de react-query-cache staat erboven.
 */
export function LocaleProvider({ initial, children }: { initial: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initial);
  if (!IS_SERVER) current = locale;
  const setLocale = useCallback((l: Locale) => {
    current = l;
    writeLocaleCookie(l);
    document.documentElement.lang = l;
    setLocaleState(l);
  }, []);
  const value = useMemo(() => ({ locale, t: DICTS[locale], setLocale }), [locale, setLocale]);
  return (
    <LocaleContext.Provider value={value}>
      <Fragment key={locale}>{children}</Fragment>
    </LocaleContext.Provider>
  );
}

export const useT = () => useContext(LocaleContext).t;
export const useLocale = () => useContext(LocaleContext);
