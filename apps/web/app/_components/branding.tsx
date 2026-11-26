"use client";
import { Server } from "lucide-react";
import { useEffect } from "react";
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

export function BrandMark({ className, size = "md" }: { className?: string; size?: "md" | "lg" }) {
  const branding = trpc.auth.branding.useQuery(undefined, { staleTime: 60_000 });
  const name = branding.data?.panelName;
  const logo = branding.data?.logoUrl;
  const box = size === "lg" ? "size-12" : "size-8";
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt="" className={cn(box, "rounded-md object-contain")} />
      ) : (
        <span className={cn(box, "grid place-items-center rounded-md bg-primary/15 text-primary")}>
          <Server className={size === "lg" ? "size-6" : "size-4"} />
        </span>
      )}
      <span className={cn("font-semibold tracking-tight", size === "lg" ? "text-2xl" : "text-base")} data-testid="panel-name">
        {name ?? " "}
      </span>
    </span>
  );
}
