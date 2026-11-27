/** Cron-hulp voor het schemascherm: voorbeelden en een voorvertoning van de volgende uitvoeringen. */
import { CronExpressionParser } from "cron-parser";

export const SCHEDULE_TZ = "Europe/Amsterdam";

export const CRON_PRESETS = [
  { key: "every5", cron: "*/5 * * * *" },
  { key: "hourly", cron: "0 * * * *" },
  { key: "daily0", cron: "0 0 * * *" },
  { key: "daily4", cron: "0 4 * * *" },
  { key: "weekly", cron: "0 4 * * 0" },
  { key: "monthly", cron: "0 4 1 * *" },
] as const;

export type CronPreview = { ok: true; next: Date[] } | { ok: false };

/** Controleert een expressie met vijf velden en geeft de volgende `count` uitvoeringen. */
export function previewCron(expr: string, count = 5, from: Date = new Date()): CronPreview {
  const e = expr.trim();
  if (e.split(/\s+/).length !== 5) return { ok: false };
  try {
    const it = CronExpressionParser.parse(e, { tz: SCHEDULE_TZ, currentDate: from });
    return { ok: true, next: Array.from({ length: count }, () => it.next().toDate()) };
  } catch {
    return { ok: false };
  }
}
