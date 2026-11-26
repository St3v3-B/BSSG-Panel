import type { ServerStatus } from "@panel/api";
import type { BadgeVariant } from "@/app/_components/ui/badge";

const nf1 = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 });

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
  if (d > 0) return `${d}d ${h}u`;
  if (h > 0) return `${h}u ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const dtf = new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Amsterdam" });
export function formatDate(d: Date | null | undefined): string {
  return d ? dtf.format(d) : "–";
}

/** CPU-limiet: 100 = één core; 0 = onbeperkt. */
export function formatCpuLimit(cpuPct: number): string {
  if (cpuPct === 0) return "onbeperkt";
  const cores = cpuPct / 100;
  return `${nf1.format(cores)} ${cores === 1 ? "core" : "cores"}`;
}

/** Percentage van de limiet (null als onbeperkt of onbekend). */
export function usagePct(used: number, limit: number): number | null {
  if (!limit || limit <= 0) return null;
  return (used / limit) * 100;
}

export const STATUS_LABEL: Record<ServerStatus, string> = {
  installing: "Installeren",
  install_failed: "Installatie mislukt",
  offline: "Offline",
  starting: "Opstarten",
  online: "Online",
  stopping: "Stoppen",
  disk_exceeded: "Schijf vol",
  unknown: "Onbekend",
};

export const STATUS_VARIANT: Record<ServerStatus, BadgeVariant> = {
  installing: "info",
  install_failed: "destructive",
  offline: "secondary",
  starting: "warning",
  online: "success",
  stopping: "warning",
  disk_exceeded: "destructive",
  unknown: "secondary",
};

export const isRunning = (s: ServerStatus) => s === "online" || s === "starting" || s === "stopping";

const KNOWN: readonly string[] = Object.keys(STATUS_LABEL);
/** Websocket-state (string) naar ServerStatus; onbekend → "unknown". */
export function toServerStatus(state: string | undefined | null): ServerStatus {
  return state && KNOWN.includes(state) ? (state as ServerStatus) : "unknown";
}
