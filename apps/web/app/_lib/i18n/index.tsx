"use client";
import { createContext, Fragment, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_LOCALE, INTL_LOCALE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from "./config";
import { en, type Dict } from "./en";
import { nl } from "./nl";

export * from "./config";
export type { Dict };

export const DICTS: Record<Locale, Dict> = { en, nl };

// Huidige taal voor hulpfuncties buiten React (errorText, formatDate, …). De provider zet hem bij elke render.
let current: Locale = DEFAULT_LOCALE;
export const getLocale = () => current;
export const getT = (): Dict => DICTS[current];
export const intlLocale = () => INTL_LOCALE[current];

interface Ctx {
  locale: Locale;
  t: Dict;
  setLocale: (l: Locale) => void;
}
const LocaleContext = createContext<Ctx>({ locale: DEFAULT_LOCALE, t: en, setLocale: () => {} });

export function writeLocaleCookie(l: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
}

/**
 * Geeft de taal door. Bij een wissel worden de kinderen opnieuw gemount (key), zodat ook
 * hulpfuncties die getT() gebruiken de nieuwe taal tonen; de react-query-cache staat erboven.
 */
export function LocaleProvider({ initial, children }: { initial: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initial);
  current = locale;
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
