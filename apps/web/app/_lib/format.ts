import type { ServerStatus } from "@panel/api";
import type { BadgeVariant } from "@/app/_components/ui/badge";
import { getLocale, getT, intlLocale } from "@/app/_lib/i18n";

// Getal- en datumnotatie volgt de gekozen taal (en-GB of nl-NL).
const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
function nf(digits: number): Intl.NumberFormat {
  const k = `n${digits}:${intlLocale()}`;
  let f = cache.get(k) as Intl.NumberFormat | undefined;
  if (!f) cache.set(k, (f = new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: digits })));
  return f;
}
const nf1 = { format: (n: number) => nf(1).format(n) };
const nf0 = { format: (n: number) => nf(0).format(n) };

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "–";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${(i === 0 ? nf0 : nf1).format(bytes < 0 ? -v : v)} ${units[i]}`;
}

export function formatMb(mb: number): string {
  return formatBytes(mb * 1024 * 1024);
}

export function formatPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "–";
  return `${nf1.format(pct)}%`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const hu = getLocale() === "nl" ? "u" : "h";
  if (d > 0) return `${d}d ${h}${hu}`;
  if (h > 0) return `${h}${hu} ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return "–";
  const k = `d:${intlLocale()}`;
  let f = cache.get(k) as Intl.DateTimeFormat | undefined;
  if (!f) cache.set(k, (f = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Amsterdam" })));
  return f.format(d);
}

/** Tijd (uu:mm:ss) in de taal van het panel, tijdzone Europe/Amsterdam. */
export function formatTime(d: Date): string {
  return d.toLocaleTimeString(intlLocale(), { timeZone: "Europe/Amsterdam" });
}

/** CPU-limiet: 100 = één core; 0 = onbeperkt. */
export function formatCpuLimit(cpuPct: number): string {
  if (cpuPct === 0) return getT().common.unlimited;
  const cores = cpuPct / 100;
  return getT().server.cores(nf1.format(cores), cores === 1);
}

/** Percentage van de limiet (null als onbeperkt of onbekend). */
export function usagePct(used: number, limit: number): number | null {
  if (!limit || limit <= 0) return null;
  return (used / limit) * 100;
}

/** Statusnaam in de huidige taal. */
export const statusLabel = (s: ServerStatus) => getT().status[s];

export const STATUS_VARIANT: Record<ServerStatus, BadgeVariant> = {
  installing: "info",
  install_failed: "destructive",
  offline: "secondary",
  starting: "warning",
  online: "success",
  stopping: "warning",
  disk_exceeded: "destructive",
  sleeping: "sleep",
  unknown: "secondary",
};

export const isRunning = (s: ServerStatus) => s === "online" || s === "starting" || s === "stopping";

const KNOWN: readonly string[] = Object.keys(STATUS_VARIANT);
/** Websocket-state (string) naar ServerStatus; onbekend → "unknown". */
export function toServerStatus(state: string | undefined | null): ServerStatus {
  return state && KNOWN.includes(state) ? (state as ServerStatus) : "unknown";
}
