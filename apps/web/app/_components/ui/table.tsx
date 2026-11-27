"use client";
import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Tabel die onder md een lijst gestapelde kaarten wordt (CSS in globals.css). De labels komen uit de
 * kolomkoppen: we zetten ze als data-label op elke cel, zodat bestaande tabellen niets hoeven te
 * veranderen. Kolommen zonder tekst in de kop (acties) krijgen geen label.
 */
export function Table({ className, ...props }: ComponentProps<"table">) {
  const ref = useRef<HTMLTableElement>(null);
  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    const labels = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent?.trim() ?? "");
    for (const tr of table.querySelectorAll("tbody > tr")) {
      let col = 0;
      for (const td of Array.from(tr.children) as HTMLElement[]) {
        const span = Number(td.getAttribute("colspan") ?? 1);
        if (span === 1 && !td.hasAttribute("data-label")) td.setAttribute("data-label", labels[col] ?? "");
        col += span;
      }
    }
  });
  return <table ref={ref} className={cn("stack-table w-full text-sm", className)} {...props} />;
}
