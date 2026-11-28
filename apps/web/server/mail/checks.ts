/**
 * Systeemcheck van de mailmodule: draaien via de daemon, laatste rapport bewaren (settings `mail_check_report`),
 * Discord-melding als een verplichte check van groen naar rood gaat, en de uurlijkse taak vanuit de scheduler.
 */
import { MailCheckId, type MailCheckReport } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db";
import { call, DaemonHttpError } from "../daemon";
import { getEnv } from "../env";
import { getAdminHook } from "../notify";
import { deliverDue, enqueue } from "../outbox";
import { mailDaemon, type DaemonMailCheckReport } from "./daemon";

export const REPORT_KEY = "mail_check_report";
const RELOAD_KEY = "mail_last_reload";
export const REPORT_MAX_AGE_MS = 3_600_000;

interface StoredReport {
  checkedAt: string;
  checks: MailCheckReport["checks"];
}

const KNOWN = new Set<string>(MailCheckId.options);

export function fromDaemon(r: DaemonMailCheckReport): MailCheckReport {
  const checks = r.checks
    .filter((c) => KNOWN.has(c.id))
    .map((c) => ({ id: c.id as MailCheckReport["checks"][number]["id"], ok: !!c.ok, required: !!c.required, detail: c.detail ?? "", hint: c.hint ?? null, data: c.data ?? null }));
  const at = new Date(r.checked_at);
  return { checkedAt: Number.isNaN(at.getTime()) ? new Date() : at, checks, ok: checks.every((c) => c.ok || !c.required) };
}

export async function lastReport(): Promise<MailCheckReport | null> {
  const [r] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, REPORT_KEY));
  const v = r?.value as StoredReport | undefined;
  if (!v || typeof v.checkedAt !== "string" || !Array.isArray(v.checks)) return null;
  const checks = v.checks.filter((c) => KNOWN.has(c.id));
  return { checkedAt: new Date(v.checkedAt), checks, ok: checks.every((c) => c.ok || !c.required) };
}

async function setSetting(key: string, value: unknown) {
  await getDb()
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

export function requireMailHostname(): string {
  const h = getEnv().MAIL_HOSTNAME;
  if (!h) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MAIL_NOT_CONFIGURED" });
  return h;
}

/** Verplichte checks die van groen (vorige keer) naar rood (nu) gingen. */
export function newlyFailed(prev: MailCheckReport | null, next: MailCheckReport): MailCheckReport["checks"] {
  if (!prev) return [];
  const before = new Map(prev.checks.map((c) => [c.id, c.ok]));
  return next.checks.filter((c) => c.required && !c.ok && before.get(c.id) === true);
}

/** Draait de check via de daemon en bewaart het rapport; meldt nieuw rode verplichte checks op Discord. */
export async function runChecks(): Promise<MailCheckReport> {
  const env = getEnv();
  const host = requireMailHostname();
  const d = await mailDaemon();
  const raw = await call(() => d.mailChecks({ mail_hostname: host, public_ipv4: env.MAIL_PUBLIC_IPV4 ?? null, public_ipv6: env.MAIL_PUBLIC_IPV6 ?? null }));
  const report = fromDaemon(raw);
  const prev = await lastReport();
  await setSetting(REPORT_KEY, { checkedAt: report.checkedAt.toISOString(), checks: report.checks } satisfies StoredReport);
  const failed = newlyFailed(prev, report);
  if (failed.length) await notifyFailed(host, failed).catch((e) => console.error("[mail] notify:", e));
  return report;
}

async function notifyFailed(host: string, failed: MailCheckReport["checks"]): Promise<void> {
  const url = await getAdminHook();
  if (!url) return;
  const ids = await enqueue([
    {
      channel: "discord",
      target: url,
      event: "mail_check_failed",
      payload: {
        embeds: [
          {
            title: `Mail check failed: ${host}`,
            description: "A required mail system check went from green to red.",
            color: 0xef4444,
            fields: failed.map((c) => ({ name: c.id, value: `${c.detail}${c.hint ? `\n→ ${c.hint}` : ""}`.slice(0, 1000) })),
            timestamp: new Date().toISOString(),
            footer: { text: "Mail" },
          },
        ],
      },
    },
  ]);
  if (ids.length) await deliverDue({ ids });
}

/** Rapport voor `mail.enable`: het laatste als dat ≤ 1 uur oud is, anders een nieuwe check. */
export async function reportForEnable(now = Date.now()): Promise<MailCheckReport> {
  const last = await lastReport();
  if (last && now - last.checkedAt.getTime() <= REPORT_MAX_AGE_MS) return last;
  return runChecks();
}

// ---------- uurlijkse taak ----------

let running = false;

/**
 * Vanuit de scheduler-tik: elk uur de systeemcheck (alleen met MAIL_HOSTNAME), de DNS van domeinen waarvan de
 * laatste controle ouder is dan een uur, en dagelijks een reload van Postfix/Dovecot (nieuwe certificaten) als
 * de stack aan staat.
 */
export async function mailTick(now = new Date()): Promise<void> {
  if (running || !getEnv().MAIL_HOSTNAME) return;
  running = true;
  try {
    const last = await lastReport();
    if (!last || now.getTime() - last.checkedAt.getTime() >= REPORT_MAX_AGE_MS) await runChecks().catch((e) => console.warn(`[mail] check: ${(e as Error).message}`));
    const { recheckStaleDomains } = await import("./router");
    await recheckStaleDomains(now).catch((e) => console.warn(`[mail] dns: ${(e as Error).message}`));
    await dailyReload(now).catch((e) => console.warn(`[mail] reload: ${(e as Error).message}`));
  } finally {
    running = false;
  }
}

async function dailyReload(now: Date): Promise<void> {
  const [r] = await getDb().select().from(schema.settings).where(inArray(schema.settings.key, [RELOAD_KEY]));
  const lastAt = typeof r?.value === "string" ? new Date(r.value).getTime() : 0;
  if (now.getTime() - lastAt < 24 * 3_600_000) return;
  const d = await mailDaemon();
  const st = await d.mailStatus();
  await setSetting(RELOAD_KEY, now.toISOString());
  if (!st.enabled) return;
  try {
    await d.mailReload();
  } catch (e) {
    if (!(e instanceof DaemonHttpError)) throw e;
  }
}
