/**
 * Wachtrij voor uitgaande meldingen (tabel `notification_outbox`): e-mail en Discord, met retries.
 *
 * - Elke rij is één bericht naar één ontvanger. Het doel staat versleuteld (`target_enc`), de hash
 *   ernaast voor de limiet per ontvanger.
 * - Claimen gebeurt met `FOR UPDATE SKIP LOCKED` en een lease (`next_attempt_at` in de toekomst),
 *   zodat twee panelprocessen nooit hetzelfde bericht versturen en een gecrasht proces niets kwijtraakt.
 * - Mislukt: opnieuw na 30 s, 2 min, 10 min, 30 min, 2 uur; daarna (of bij een permanente fout) `failed`.
 * - Limiet: per ontvanger hooguit RATE_PER_HOUR berichten per uur; de rest wordt `dropped`
 *   (geen 100 mails bij een crashloop, ook niet over herstarts heen).
 */
import { and, count, eq, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { decrypt, encrypt, sha256 } from "./lib/crypto";
import { isPermanentMailError, mailErrorText, sendMail } from "./mailer";
import { sendWebhook, type Embed } from "./discord-webhook";

export type OutboxChannel = "email" | "discord";
export interface EmailPayload {
  subject: string;
  html: string;
  text: string;
}
export interface DiscordPayload {
  embeds: Embed[];
  username?: string;
}
export interface OutboxItem {
  channel: OutboxChannel;
  target: string;
  event: string;
  payload: EmailPayload | DiscordPayload;
}

export const MAX_ATTEMPTS = 6;
export const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
export const RATE_PER_HOUR: Record<OutboxChannel, number> = { email: 10, discord: 30 };
const LEASE_MS = 120_000;

const targetHash = (channel: OutboxChannel, target: string) => sha256(`${channel}:${target.toLowerCase()}`);

/** Zet berichten in de wachtrij; geeft de ids die verstuurd mogen worden (niet over de limiet). */
export async function enqueue(items: OutboxItem[], now = new Date()): Promise<number[]> {
  if (!items.length) return [];
  const db = getDb();
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const hashes = [...new Set(items.map((i) => targetHash(i.channel, i.target)))];
  const recent = await db
    .select({ h: schema.notificationOutbox.targetHash, n: count() })
    .from(schema.notificationOutbox)
    .where(and(inArray(schema.notificationOutbox.targetHash, hashes), gte(schema.notificationOutbox.createdAt, hourAgo), ne(schema.notificationOutbox.status, "dropped")))
    .groupBy(schema.notificationOutbox.targetHash);
  const used = new Map(recent.map((r) => [r.h, Number(r.n)]));
  const values = items.map((i) => {
    const h = targetHash(i.channel, i.target);
    const n = used.get(h) ?? 0;
    used.set(h, n + 1);
    const dropped = n >= RATE_PER_HOUR[i.channel];
    return {
      channel: i.channel,
      targetEnc: encrypt(i.target),
      targetHash: h,
      event: i.event,
      payload: i.payload as unknown as Record<string, unknown>,
      status: dropped ? ("dropped" as const) : ("pending" as const),
      lastError: dropped ? "rate limited" : null,
      createdAt: now,
      nextAttemptAt: now,
    };
  });
  const rows = await db.insert(schema.notificationOutbox).values(values).returning({ id: schema.notificationOutbox.id, status: schema.notificationOutbox.status });
  const dropped = rows.filter((r) => r.status === "dropped").length;
  if (dropped) console.warn(`[outbox] ${dropped} message(s) dropped: more than the hourly limit for a recipient`);
  return rows.filter((r) => r.status === "pending").map((r) => r.id);
}

type Row = typeof schema.notificationOutbox.$inferSelect;

/** Claimt vervallen rijen (of precies `ids`) voor dit proces. */
async function claim(opts: { ids?: number[]; limit: number }, now: Date): Promise<Row[]> {
  const db = getDb();
  const o = schema.notificationOutbox;
  const due = db
    .select({ id: o.id })
    .from(o)
    .where(and(or(eq(o.status, "pending"), eq(o.status, "sending")), lte(o.nextAttemptAt, now), opts.ids ? inArray(o.id, opts.ids) : undefined))
    .orderBy(o.id)
    .limit(opts.limit)
    .for("update", { skipLocked: true });
  return db
    .update(o)
    .set({ status: "sending", attempts: sql`${o.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
    .where(inArray(o.id, due))
    .returning();
}

interface Outcome {
  ok: boolean;
  permanent: boolean;
  error: string | null;
  retryAfterMs?: number;
}

async function send(r: Row): Promise<Outcome> {
  let target: string;
  try {
    target = decrypt(r.targetEnc);
  } catch {
    return { ok: false, permanent: true, error: "cannot decrypt target" };
  }
  if (r.channel === "discord") {
    const p = r.payload as unknown as DiscordPayload;
    const res = await sendWebhook(target, p.embeds, { username: p.username, maxAttempts: 1 });
    if (res.ok) return { ok: true, permanent: false, error: null };
    const permanent = res.status === null ? res.attempts === 0 : res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
    return { ok: false, permanent, error: `discord status ${res.status ?? "network error"}`, retryAfterMs: res.retryAfterMs };
  }
  const p = r.payload as unknown as EmailPayload;
  try {
    await sendMail({ to: target, subject: p.subject, html: p.html, text: p.text });
    return { ok: true, permanent: false, error: null };
  } catch (e) {
    return { ok: false, permanent: isPermanentMailError(e), error: mailErrorText(e) };
  }
}

/** Verstuurt wat klaarstaat (of alleen `ids`). Geeft het aantal geslaagde berichten. Gooit nooit. */
export async function deliverDue(opts: { ids?: number[]; limit?: number } = {}): Promise<number> {
  if (opts.ids && !opts.ids.length) return 0;
  const db = getDb();
  let sent = 0;
  try {
    const rows = await claim({ ids: opts.ids, limit: opts.limit ?? 50 }, new Date());
    await Promise.all(
      rows.map(async (r) => {
        const res = await send(r).catch((e): Outcome => ({ ok: false, permanent: false, error: String((e as Error)?.message ?? e) }));
        const o = schema.notificationOutbox;
        if (res.ok) {
          sent++;
          await db.update(o).set({ status: "sent", sentAt: new Date(), lastError: null }).where(eq(o.id, r.id));
          return;
        }
        const give = res.permanent || r.attempts >= MAX_ATTEMPTS;
        const wait = Math.max(BACKOFF_MS[Math.min(r.attempts - 1, BACKOFF_MS.length - 1)]!, res.retryAfterMs ?? 0);
        await db
          .update(o)
          .set(give ? { status: "failed", lastError: res.error } : { status: "pending", lastError: res.error, nextAttemptAt: new Date(Date.now() + wait) })
          .where(eq(o.id, r.id));
        if (give) console.warn(`[outbox] ${r.channel} ${r.event}: gave up after ${r.attempts} attempt(s): ${res.error}`);
      }),
    );
  } catch (e) {
    console.error("[outbox] deliver:", e);
  }
  return sent;
}

/** Oude rijen opruimen: verstuurd/gedropt na 7 dagen, mislukt na 30 dagen. */
export async function cleanupOutbox(now = new Date()): Promise<void> {
  const o = schema.notificationOutbox;
  const week = new Date(now.getTime() - 7 * 86_400_000);
  const month = new Date(now.getTime() - 30 * 86_400_000);
  await getDb()
    .delete(o)
    .where(or(and(inArray(o.status, ["sent", "dropped"]), lt(o.createdAt, week)), and(eq(o.status, "failed"), lt(o.createdAt, month))));
}
