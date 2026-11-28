/** Meldingen voor de gebruiker: voorkeuren per kanaal, e-mailadres met verificatie, inbox; admin: SMTP. */
import type { EmailStatus, Implementation, NotificationSettings } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gt, gte, inArray, isNull, lt } from "drizzle-orm";
import { logActivity } from "../activity";
import { forbidApiKey } from "../apikey";
import { getDb, schema } from "../db";
import { renderMail } from "../email-render";
import { getEnv } from "../env";
import { randomToken, sha256 } from "../lib/crypto";
import { getSmtpConfig, getSmtpSettings, mailErrorText, sendMail, setSmtpSettings } from "../mailer";
import { getUserHook, resolvePrefs } from "../notify";
import { getSettings } from "../settings";

const ok = { ok: true as const };
export const VERIFY_TTL_MS = 24 * 3_600_000;
/** Verificatiemails per gebruiker per uur. */
export const VERIFY_PER_HOUR = 5;

async function userRow(id: number) {
  const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, id));
  if (!u) throw new TRPCError({ code: "UNAUTHORIZED" });
  return u;
}

export async function emailStatus(userId: number): Promise<EmailStatus> {
  const u = await userRow(userId);
  const [p] = await getDb()
    .select({ email: schema.emailVerifications.email })
    .from(schema.emailVerifications)
    .where(and(eq(schema.emailVerifications.userId, userId), isNull(schema.emailVerifications.usedAt), gt(schema.emailVerifications.expiresAt, new Date())))
    .orderBy(desc(schema.emailVerifications.id))
    .limit(1);
  const address = u.email && u.emailVerifiedAt ? u.email : null;
  return { address, pending: p && p.email !== address ? p.email : null };
}

async function settingsFor(userId: number, isAdmin: boolean): Promise<NotificationSettings> {
  const u = await userRow(userId);
  return {
    prefs: resolvePrefs(u.notificationPrefs, isAdmin),
    email: await emailStatus(userId),
    discordSet: !!(await getUserHook(userId)),
    emailAvailable: !!(await getSmtpConfig()),
  };
}

async function branding() {
  const s = await getSettings();
  return { panelName: s.panelName, logoUrl: s.logoUrl, accentColor: s.accentColor };
}

/** Maakt een verificatielink en mailt hem. Gooit TOO_MANY_REQUESTS / PRECONDITION_FAILED / BAD_REQUEST. */
async function sendVerification(userId: number, email: string): Promise<void> {
  const db = getDb();
  const cfg = await getSmtpConfig();
  if (!cfg) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "SMTP_NOT_CONFIGURED" });
  const [r] = await db
    .select({ n: count() })
    .from(schema.emailVerifications)
    .where(and(eq(schema.emailVerifications.userId, userId), gte(schema.emailVerifications.createdAt, new Date(Date.now() - 3_600_000))));
  if (Number(r?.n ?? 0) >= VERIFY_PER_HOUR) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "RATE_LIMITED" });
  // Eerdere links voor dit account vervallen.
  await db.update(schema.emailVerifications).set({ usedAt: new Date() }).where(and(eq(schema.emailVerifications.userId, userId), isNull(schema.emailVerifications.usedAt)));
  const token = randomToken(32);
  await db.insert(schema.emailVerifications).values({ userId, email, tokenHash: sha256(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) });
  const url = `${getEnv().PANEL_URL}/verify-email?token=${encodeURIComponent(token)}`;
  const b = await branding();
  const mail = renderMail(
    {
      subject: `Confirm your e-mail address for ${b.panelName}`,
      title: "Confirm your e-mail address",
      level: "info",
      paragraphs: [`Click the button to receive notifications from ${b.panelName} at ${email}. The link is valid for 24 hours.`, "Did you not ask for this? Then you can ignore this e-mail."],
      button: { label: "Confirm e-mail address", url },
    },
    b,
    getEnv().PANEL_URL,
  );
  try {
    await sendMail({ to: email, ...mail }, cfg);
  } catch (e) {
    console.warn("[email] verification mail failed:", mailErrorText(e));
    throw new TRPCError({ code: "BAD_REQUEST", message: "EMAIL_FAILED" });
  }
}

export const notifyAccount: Pick<Implementation["account"], "notificationSettings" | "setNotificationPrefs" | "setEmail" | "resendEmailVerification" | "testEmail"> = {
  notificationSettings: async ({ ctx }) => settingsFor(ctx.session!.userId, ctx.session!.isAdmin),
  setNotificationPrefs: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const u = await userRow(ctx.session!.userId);
    const next = { ...(u.notificationPrefs ?? {}) };
    for (const [k, v] of Object.entries(input.prefs)) if (v) next[k] = { panel: v.panel, discord: v.discord, email: v.email };
    await getDb().update(schema.users).set({ notificationPrefs: next }).where(eq(schema.users.id, u.id));
    return settingsFor(u.id, ctx.session!.isAdmin);
  },
  setEmail: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const userId = ctx.session!.userId;
    const db = getDb();
    if (input.email === null) {
      await db.update(schema.users).set({ email: null, emailVerifiedAt: null }).where(eq(schema.users.id, userId));
      await db.update(schema.emailVerifications).set({ usedAt: new Date() }).where(and(eq(schema.emailVerifications.userId, userId), isNull(schema.emailVerifications.usedAt)));
      await logActivity({ action: "account.email.remove", userId, ip: ctx.ip, ctx });
      return emailStatus(userId);
    }
    const cur = await emailStatus(userId);
    if (cur.address === input.email) return cur;
    await sendVerification(userId, input.email);
    await logActivity({ action: "account.email.verification_sent", userId, ip: ctx.ip, ctx });
    return emailStatus(userId);
  },
  resendEmailVerification: async ({ ctx }) => {
    forbidApiKey(ctx);
    const st = await emailStatus(ctx.session!.userId);
    if (!st.pending) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_PENDING_EMAIL" });
    await sendVerification(ctx.session!.userId, st.pending);
    return ok;
  },
  testEmail: async ({ ctx }) => {
    forbidApiKey(ctx);
    const st = await emailStatus(ctx.session!.userId);
    if (!st.address) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "EMAIL_NOT_VERIFIED" });
    const cfg = await getSmtpConfig();
    if (!cfg) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "SMTP_NOT_CONFIGURED" });
    const b = await branding();
    const mail = renderMail(
      { subject: `Test e-mail from ${b.panelName}`, title: "Test e-mail", level: "success", paragraphs: [`E-mail notifications from ${b.panelName} reach this address.`], button: { label: "Notification settings", url: `${getEnv().PANEL_URL}/account` } },
      b,
      getEnv().PANEL_URL,
    );
    try {
      await sendMail({ to: st.address, ...mail }, cfg);
    } catch (e) {
      console.warn("[email] test mail failed:", mailErrorText(e));
      throw new TRPCError({ code: "BAD_REQUEST", message: "EMAIL_FAILED" });
    }
    return ok;
  },
};

export const verifyEmail: Implementation["auth"]["verifyEmail"] = async ({ input }) => {
  const db = getDb();
  const v = schema.emailVerifications;
  // Atomair claimen: een link werkt maar één keer.
  const [row] = await db
    .update(v)
    .set({ usedAt: new Date() })
    .where(and(eq(v.tokenHash, sha256(input.token)), isNull(v.usedAt), gt(v.expiresAt, new Date())))
    .returning();
  if (!row) throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_TOKEN" });
  await db.update(schema.users).set({ email: row.email, emailVerifiedAt: new Date() }).where(eq(schema.users.id, row.userId));
  await logActivity({ action: "account.email.verified", userId: row.userId });
  return { ok: true as const, email: row.email };
};

// ---------- inbox ----------

export const inbox: Implementation["inbox"] = {
  list: async ({ input, ctx }) => {
    const n = schema.notifications;
    const before = input.cursor ? Number(input.cursor) : null;
    const rows = await getDb()
      .select({ n, server: { uuid: schema.servers.uuid, name: schema.servers.name } })
      .from(n)
      .leftJoin(schema.servers, eq(schema.servers.id, n.serverId))
      .where(and(eq(n.userId, ctx.session!.userId), input.unreadOnly ? isNull(n.readAt) : undefined, before && Number.isFinite(before) ? lt(n.id, before) : undefined))
      .orderBy(desc(n.id))
      .limit(input.limit + 1);
    const items = rows.slice(0, input.limit).map(({ n: x, server }) => ({
      id: x.id,
      event: x.event as never,
      level: x.level,
      title: x.title,
      body: x.body,
      server: server?.uuid ? { uuid: server.uuid, name: server.name } : null,
      link: x.link,
      createdAt: x.createdAt,
      readAt: x.readAt,
    }));
    return { items, nextCursor: rows.length > input.limit ? String(items.at(-1)!.id) : null };
  },
  unreadCount: async ({ ctx }) => {
    const [r] = await getDb()
      .select({ c: count() })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, ctx.session!.userId), isNull(schema.notifications.readAt)));
    return { count: Number(r?.c ?? 0) };
  },
  markRead: async ({ input, ctx }) => {
    const n = schema.notifications;
    await getDb()
      .update(n)
      .set({ readAt: new Date() })
      .where(and(eq(n.userId, ctx.session!.userId), isNull(n.readAt), input.ids ? inArray(n.id, input.ids.length ? input.ids : [-1]) : undefined));
    return ok;
  },
};

/** Inbox-items ouder dan 90 dagen en verlopen verificatielinks weg. */
export async function cleanupInbox(now = new Date()): Promise<void> {
  const db = getDb();
  await db.delete(schema.notifications).where(lt(schema.notifications.createdAt, new Date(now.getTime() - 90 * 86_400_000)));
  await db.delete(schema.emailVerifications).where(lt(schema.emailVerifications.expiresAt, new Date(now.getTime() - 86_400_000)));
}

// ---------- admin: SMTP ----------

export const smtpAdmin: Implementation["admin"]["smtp"] = {
  get: () => getSmtpSettings(),
  set: async ({ input, ctx }) => {
    if (input.host && !input.from && !input.username) throw new TRPCError({ code: "BAD_REQUEST", message: "SMTP_FROM_REQUIRED" });
    const r = await setSmtpSettings(input);
    await logActivity({
      action: input.host ? "admin.smtp.update" : "admin.smtp.remove",
      userId: ctx.session!.userId,
      metadata: input.host ? { host: input.host, port: input.port, security: input.security, password: input.password === undefined ? "unchanged" : input.password ? "set" : "removed" } : {},
      ip: ctx.ip,
      ctx,
    });
    return r;
  },
  test: async ({ input }) => {
    const cfg = await getSmtpConfig();
    if (!cfg) return { ok: false, error: "SMTP is not configured" };
    const b = await branding();
    const mail = renderMail(
      { subject: `Test e-mail from ${b.panelName}`, title: "SMTP works", level: "success", paragraphs: [`This test e-mail was sent by ${b.panelName} via ${cfg.host}:${cfg.port}.`] },
      b,
      getEnv().PANEL_URL,
    );
    try {
      await sendMail({ to: input.to, ...mail }, cfg);
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: mailErrorText(e) };
    }
  },
};
