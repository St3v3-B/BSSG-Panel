"use client";
/** Kleine bouwstenen voor de mailmodule: schakelaar, voortgangsring, quotabalk, tabs, kopieerwaarde, relatieve tijd. */
import { Check, ChevronDown, Copy } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useCopy } from "@/app/_hooks/use-copy";
import { intlLocale, useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";

/** Toegankelijke aan/uit-schakelaar (role=switch). */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  size = "default",
  className,
  ...rest
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  size?: "default" | "lg";
  className?: string;
  "data-testid"?: string;
}) {
  const lg = size === "lg";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-[background-color,box-shadow] duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        lg ? "h-8 w-14" : "h-6 w-10",
        checked ? "bg-success" : "bg-muted-foreground/30",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none block rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ease-out",
          lg ? "size-6" : "size-[18px]",
          checked ? (lg ? "translate-x-[26px]" : "translate-x-[18px]") : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

/** Ring met "x van y". */
export function ProgressRing({ value, total, size = 96, stroke = 8, tone, children, label }: { value: number; total: number; size?: number; stroke?: number; tone?: "success" | "warning" | "destructive" | "muted"; children?: ReactNode; label: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? Math.min(1, value / total) : 0;
  const color = tone ?? (total === 0 ? "muted" : pct >= 1 ? "success" : pct >= 0.7 ? "warning" : "destructive");
  const stroke_ = { success: "stroke-success", warning: "stroke-warning", destructive: "stroke-destructive", muted: "stroke-muted-foreground/40" }[color];
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-muted" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          className={cn("transition-[stroke-dashoffset] duration-700 ease-out", stroke_)}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

/** Kleur van een gebruiksbalk: groen → oranje (≥ 75%) → rood (≥ 90%). */
export function usageTone(pct: number | null): "success" | "warning" | "destructive" | "muted" {
  if (pct == null) return "muted";
  return pct >= 90 ? "destructive" : pct >= 75 ? "warning" : "success";
}

/** Quotabalk met vloeiende kleur (groen → oranje → rood); `pct` null = onbeperkt/onbekend. */
export function QuotaBar({ pct, label, className }: { pct: number | null; label: string; className?: string }) {
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  // hue 150 (groen) → 70 (oranje) → 25 (rood)
  const hue = v <= 60 ? 150 : v <= 80 ? 150 - ((v - 60) / 20) * 75 : Math.max(25, 75 - ((v - 80) / 12) * 50);
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct == null ? undefined : Math.round(v)} className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      {pct != null && <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(v, 2)}%`, background: `oklch(0.68 0.17 ${hue})` }} />}
    </div>
  );
}

/** Statusstip, optioneel pulserend. */
export function Dot({ tone, pulse, className }: { tone: "success" | "warning" | "destructive" | "muted" | "info"; pulse?: boolean; className?: string }) {
  const bg = { success: "bg-success", warning: "bg-warning", destructive: "bg-destructive", muted: "bg-muted-foreground/50", info: "bg-info" }[tone];
  return (
    <span aria-hidden className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", bg)} />}
      <span className={cn("relative inline-flex size-2 rounded-full", bg)} />
    </span>
  );
}

export interface TabDef<K extends string> {
  key: K;
  label: string;
  icon?: typeof Check;
  count?: number;
}

/** Tabs met pijltjestoetsen (WAI-ARIA tabs-patroon). */
export function Tabs<K extends string>({ tabs, value, onChange, label, idBase }: { tabs: TabDef<K>[]; value: K; onChange: (k: K) => void; label: string; idBase: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: KeyboardEvent, i: number) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    let next = -1;
    if (dir) next = (i + dir + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const k = tabs[next]!.key;
    onChange(k);
    refs.current[k]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0">
      {tabs.map((t, i) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            ref={(el) => void (refs.current[t.key] = el)}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.key}`}
            aria-selected={active}
            aria-controls={`${idBase}-panel-${t.key}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              "-mb-px inline-flex min-h-11 items-center gap-2 whitespace-nowrap border-b-2 px-3.5 text-sm font-medium transition-colors outline-none focus-visible:bg-accent/60 [&_svg]:size-4",
              active ? "border-primary text-foreground [&_svg]:text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.icon && <t.icon />}
            {t.label}
            {t.count != null && <span className={cn("rounded-full px-1.5 text-xs tabular-nums", active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idBase, k, children }: { idBase: string; k: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel-${k}`} aria-labelledby={`${idBase}-tab-${k}`} tabIndex={0} className="outline-none">
      {children}
    </div>
  );
}

/** Kopieerknop met zichtbare "Gekopieerd!"-feedback (tekstlabel, niet alleen een icoon). */
export function CopyPill({ value, label, className }: { value: string; label: string; className?: string }) {
  const t = useT().mail;
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      aria-label={copied ? t.copied : label}
      title={label}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:h-8 [&_svg]:size-3.5",
        copied ? "border-success/40 bg-success/10 text-success" : "border-border bg-card/60 text-muted-foreground hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {copied ? <Check className="animate-[pop_0.3s_ease-out]" /> : <Copy />}
      <span aria-live="polite">{copied ? t.copied : t.copy}</span>
    </button>
  );
}

/** Lange waarde in monospace, afgekapt met uitklapknop, plus kopiëren. */
export function CopyValue({ value, label, clampAt = 64 }: { value: string; label: string; clampAt?: number }) {
  const t = useT().mail;
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = value.length > clampAt;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <code id={id} className={cn("block rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 font-mono text-xs leading-relaxed", long && !open ? "truncate" : "break-all")}>
          {value}
        </code>
        {long && (
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={id} className="mt-1 inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground">
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} /> {open ? t.showLess : t.showAll}
          </button>
        )}
      </div>
      <CopyPill value={value} label={label} className="max-sm:px-2.5 max-sm:[&>span]:sr-only" />
    </div>
  );
}

/** Relatieve tijd ("3 min geleden") in de taal van het panel, ververst elke 30 s. */
export function relativeTime(d: Date, now: number = Date.now()): string {
  const diff = (d.getTime() - now) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" });
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), "month");
  return rtf.format(Math.round(diff / (86400 * 365)), "year");
}

export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function RelativeTime({ date, className }: { date: Date; className?: string }) {
  const now = useNow();
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString(intlLocale(), { timeZone: "Europe/Amsterdam" })} className={className}>
      {relativeTime(date, now)}
    </time>
  );
}

/** Wachtwoordsterkte 0..4 (lengte + tekensoorten; herhaling telt af). */
export function passwordScore(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const unique = new Set(pw).size;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (pw.length >= 16) s++;
  if (classes >= 3) s++;
  if (unique < pw.length / 2.5 || pw.length < 8) s = Math.min(s, 1);
  return Math.max(pw.length >= 1 ? 1 : 0, Math.min(4, s)) as 0 | 1 | 2 | 3 | 4;
}

/** Sterk wachtwoord (20 tekens) met crypto.getRandomValues, zonder verwarrende tekens. */
export function generatePassword(length = 20): string {
  const sets = ["abcdefghijkmnpqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "-_.!@#%+="];
  const all = sets.join("");
  const rnd = new Uint32Array(length + sets.length);
  crypto.getRandomValues(rnd);
  const chars = sets.map((s, i) => s[rnd[i]! % s.length]!);
  for (let i = sets.length; i < length; i++) chars.push(all[rnd[i]! % all.length]!);
  // schudden
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rnd[(i + 3) % rnd.length]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

export function StrengthMeter({ password }: { password: string }) {
  const t = useT().mail.strength;
  const score = passwordScore(password);
  const tone = ["bg-muted", "bg-destructive", "bg-warning", "bg-success/70", "bg-success"][score]!;
  const text = [t.empty, t.weak, t.fair, t.good, t.strong][score]!;
  return (
    <div className="space-y-1" data-testid="strength-meter" data-score={score}>
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cn("h-1 flex-1 rounded-full transition-colors duration-300", i <= score ? tone : "bg-muted")} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {t.label}: <span className={cn("font-medium", score <= 1 ? "text-destructive" : score === 2 ? "text-warning" : "text-success")}>{text}</span>
      </p>
    </div>
  );
}
