"use client";
import { useEffect, useId } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/** Relatieve luminantie van een #rrggbb-kleur (WCAG). */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** Zet de accentkleur uit de instellingen als --primary. */
export function BrandingEffect() {
  const branding = trpc.auth.branding.useQuery(undefined, { staleTime: 60_000 });
  const accent = branding.data?.accentColor;
  useEffect(() => {
    if (!accent || !/^#[0-9a-fA-F]{6}$/.test(accent)) return;
    const root = document.documentElement;
    root.style.setProperty("--primary", accent);
    root.style.setProperty("--primary-foreground", luminance(accent) > 0.35 ? "oklch(0.145 0 0)" : "oklch(0.985 0 0)");
  }, [accent]);
  return null;
}

/** Het BSSG-symbool (drie gestapelde platen), gekleurd met de accentkleur van het panel. */
export function LogoMark({ className }: { className?: string }) {
  const id = useId();
  const slab = (o: number, top: string, left: string, right: string) => (
    <g key={o} strokeWidth="2" strokeLinejoin="round">
      <path d={`M12 ${18 + o}l20 10v7L12 ${25 + o}z`} style={{ fill: left, stroke: left }} />
      <path d={`M52 ${18 + o}L32 ${28 + o}v7l20-10z`} style={{ fill: right, stroke: right }} />
      <path d={`M32 ${8 + o}l20 10-20 10-20-10z`} style={{ fill: top, stroke: top }} />
    </g>
  );
  const p = "var(--primary)";
  const lighter = "color-mix(in oklab, var(--primary) 78%, white)";
  const darker = "color-mix(in oklab, var(--primary) 72%, black)";
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn("shrink-0", className)}>
      <defs>
        <linearGradient id={id} x1="12" y1="8" x2="52" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: "color-mix(in oklab, var(--primary) 60%, white)" }} />
          <stop offset="1" style={{ stopColor: "color-mix(in oklab, var(--primary) 35%, #22d3ee)" }} />
        </linearGradient>
      </defs>
      {slab(24, lighter, p, darker)}
      {slab(12, lighter, p, darker)}
      {slab(0, `url(#${id})`, p, darker)}
    </svg>
  );
}

export function BrandMark({ className, size = "md", showName = true, stacked = false }: { className?: string; size?: "md" | "lg"; showName?: boolean; stacked?: boolean }) {
  const branding = trpc.auth.branding.useQuery(undefined, { staleTime: 60_000 });
  const name = branding.data?.panelName;
  const logo = branding.data?.logoUrl;
  const box = size === "lg" ? (stacked ? "size-20" : "size-14") : "size-8";
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", stacked && "flex-col gap-4", className)}>
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt="" className={cn(box, "shrink-0 rounded-lg object-contain")} />
      ) : (
        <LogoMark className={cn(box, "drop-shadow-[0_4px_14px_var(--surface-glow)]")} />
      )}
      <span className={cn("truncate font-semibold tracking-tight", size === "lg" ? "text-3xl" : "text-base", stacked && "brand-text text-3xl font-bold sm:text-4xl", !showName && "sr-only")} data-testid="panel-name">
        {name ?? " "}
      </span>
    </span>
  );
}
