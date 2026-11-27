/** Cron-expressies (5 velden) in Europe/Amsterdam. */
import { CronExpressionParser } from "cron-parser";

export const SCHEDULE_TZ = "Europe/Amsterdam";

/** Volgende uitvoeringen na `from`; gooit bij een ongeldige expressie. */
export function nextRuns(cron: string, count = 1, from: Date = new Date()): Date[] {
  if (cron.trim().split(/\s+/).length !== 5) throw new Error("a cron expression needs 5 fields");
  const it = CronExpressionParser.parse(cron.trim(), { tz: SCHEDULE_TZ, currentDate: from });
  return Array.from({ length: count }, () => it.next().toDate());
}

export function validateCron(cron: string): string | null {
  try {
    nextRuns(cron);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
