"use client";
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { THEME_KEY } from "@/app/_lib/theme-script";
import { useT } from "@/app/_lib/i18n";

export type Theme = "dark" | "light";
const KEY = THEME_KEY;

function apply(theme: Theme) {
  const el = document.documentElement;
  el.classList.toggle("dark", theme === "dark");
  el.classList.toggle("light", theme === "light");
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    setTheme(document.documentElement.classList.contains("light") ? "light" : "dark");
  }, []);
  return [
    theme,
    (t) => {
      setTheme(t);
      apply(t);
      try {
        localStorage.setItem(KEY, t);
      } catch {
        /* geen storage */
      }
    },
  ];
}

/** Knop die tussen donker en licht wisselt. */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useTheme();
  const t = useT();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={theme === "dark" ? t.theme.toLight : t.theme.toDark}
      title={theme === "dark" ? t.theme.toLight : t.theme.toDark}
      data-testid="theme-toggle"
      className={cn("grid size-10 place-items-center rounded-lg border border-input bg-card/40 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:size-8", className)}
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
