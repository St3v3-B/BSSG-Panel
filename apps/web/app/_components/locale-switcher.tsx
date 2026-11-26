"use client";
import { LOCALES, useLocale, type Locale } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";

export const LOCALE_NAME: Record<Locale, string> = { en: "English", nl: "Nederlands" };

/** EN/NL-knopjes; de keuze gaat in de cookie panel_locale. */
export function LocaleSwitcher({ className }: { className?: string }) {
  const { locale, setLocale, t } = useLocale();
  return (
    <div className={cn("inline-flex rounded-md border border-border p-0.5 text-xs", className)} role="group" aria-label={t.common.language} data-testid="locale-switcher">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={locale === l}
          title={LOCALE_NAME[l]}
          onClick={() => locale !== l && setLocale(l)}
          className={cn("rounded px-2 py-1 font-medium uppercase", locale === l ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
