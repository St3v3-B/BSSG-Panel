/**
 * Meldingen: gebeurtenis → ontvangers → kanalen (in het panel, Discord, e-mail).
 *
 * Ontvangers:
 * - de webhook van de server (Target.hooks) — een kanaal van de server zelf, zonder voorkeuren;
 * - gebruikers (Target.users, meestal de eigenaar): per gebeurtenis kiezen ze zelf de kanalen
 *   (`users.notification_prefs`, standaard DEFAULT_NOTIFICATION_PREFS): inbox, eigen webhook, e-mail
 *   (alleen een geverifieerd adres en als SMTP is ingesteld);
 * - de admin-brede webhook (settings `admin_webhook_enc`) bij Target.admin;
 * - admins als gebruikers, alleen voor admin-gebeurtenissen (node offline, image-update).
 * Dezelfde webhook-URL of hetzelfde adres krijgt een bericht één keer.
 *
 * Ontdubbelen: het eerste bericht gaat meteen; gelijke gebeurtenissen (zelfde soort en
 * server/domein/node) binnen het venster (COALESCE_MS) worden geteld en aan het eind als één
 * samenvatting verstuurd. Daarnaast begrenst de wachtrij (./outbox) per ontvanger per uur.
 * E-mail en Discord gaan via de wachtrij met retries; de eerste poging gebeurt direct.
 */
import { ADMIN_NOTIFICATION_EVENTS, DEFAULT_NOTIFICATION_PREFS, type Branding, type ChannelPrefs, type NotificationEvent, type NotificationPrefs } from "@panel/api";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "./db";
import { hookStatus, isWebhookUrl, sendWebhook, transport, type Embed, type SendResult } from "./discord-webhook";
import { renderMail, type MailField, type MailLevel } from "./email-render";
import { getEnv } from "./env";
import { decrypt, encrypt } from "./lib/crypto";
import { getSmtpConfig } from "./mailer";
import { deliverDue, enqueue, type OutboxItem } from "./outbox";
import { getSettings } from "./settings";

export { hookStatus, isWebhookUrl, sendWebhook, transport, type Embed, type SendResult };

const dec = (enc: string | null | undefined): string | null => {
  if (!enc) return null;
  try {
    return decrypt(enc);
  } catch {
    return null;
  }
};

// ---------- webhooks in de database ----------

export const ADMIN_KEY = "admin_webhook_enc";

export async function getAdminHook(): Promise<string | null> {
  const [r] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, ADMIN_KEY));
  return typeof r?.value === "string" ? dec(r.value) : null;
}

export async function setAdminHook(url: string | null): Promise<void> {
  const db = getDb();
  if (!url) {
    await db.delete(schema.settings).where(eq(schema.settings.key, ADMIN_KEY));
    return;
  }
  await db
    .insert(schema.settings)
    .values({ key: ADMIN_KEY, value: encrypt(url) })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: encrypt(url), updatedAt: new Date() } });
}

export async function getUserHook(userId: number): Promise<string | null> {
  const [r] = await getDb().select({ h: schema.users.discordWebhookEnc }).from(schema.users).where(eq(schema.users.id, userId));
  return dec(r?.h);
}

export async function setUserHook(userId: number, url: string | null): Promise<void> {
  await getDb().update(schema.users).set({ discordWebhookEnc: url ? encrypt(url) : null }).where(eq(schema.users.id, userId));
}

export const serverHookOf = (s: { discordWebhookEnc: string | null }): string | null => dec(s.discordWebhookEnc);

// ---------- voorkeuren ----------

/** Volledige voorkeurentabel: opgeslagen waarden over de standaard heen; admin-gebeurtenissen uit voor niet-admins. */
export function resolvePrefs(stored: Record<string, Partial<ChannelPrefs>> | null | undefined, isAdmin: boolean): NotificationPrefs {
  const out = structuredClone(DEFAULT_NOTIFICATION_PREFS);
  for (const k of Object.keys(out) as NotificationEvent[]) {
    const v = stored?.[k];
    if (v && typeof v === "object") out[k] = { panel: v.panel ?? out[k].panel, discord: v.discord ?? out[k].discord, email: v.email ?? out[k].email };
    if (!isAdmin && ADMIN_NOTIFICATION_EVENTS.includes(k)) out[k] = { panel: false, discord: false, email: false };
  }
  return out;
}

// ---------- gebeurtenissen ----------

export type NotifyEvent =
  | { kind: "server_crashed"; exitCode: number | null; oom: boolean; logTail: string[]; crashReport: string | null; restart: "restarted" | "gave_up" | "disabled"; attempt: number }
  | { kind: "disk_warning"; usedBytes: number; limitBytes: number }
  | { kind: "disk_exceeded"; usedBytes: number; limitBytes: number }
  | { kind: "backup_failed"; name: string; error: string }
  | { kind: "backup_completed"; name: string; sizeBytes: number | null }
  | { kind: "install_failed"; error: string }
  | { kind: "ssl_failed"; hostname: string }
  | { kind: "node_offline"; nodeName: string; error: string | null }
  | { kind: "node_online"; nodeName: string }
  | { kind: "login_new_ip"; ip: string; userAgent: string | null }
  | { kind: "image_update"; reinstallRequired: boolean }
  | { kind: "deploy_failed"; branch: string; commit: string | null; error: string; logTail: string[] }
  | { kind: "deploy_succeeded"; branch: string; commit: string | null };

export interface Target {
  /** Voor de titel en de link; null bij node- en accountgebeurtenissen. */
  server: { uuid: string; name: string } | null;
  /** Webhooks van de server(s) (al ontsleuteld). */
  hooks: string[];
  /** Ook naar de admin-webhook (en admins, bij admin-gebeurtenissen). */
  admin: boolean;
  /** Gebruikers die het krijgen volgens hun eigen voorkeuren (meestal de eigenaar). */
  users?: number[];
}

/** Voorkeur-sleutel voor gewone ontvangers. */
export function prefKeyOf(e: NotifyEvent): NotificationEvent {
  switch (e.kind) {
    case "disk_warning":
    case "disk_exceeded":
      return "disk";
    case "node_offline":
    case "node_online":
      return "server_unreachable";
    default:
      return e.kind;
  }
}

/** Voorkeur-sleutel voor admins (alleen admin-gebeurtenissen). */
export function adminPrefKeyOf(e: NotifyEvent): NotificationEvent | null {
  if (e.kind === "node_offline" || e.kind === "node_online") return "node_offline";
  if (e.kind === "image_update") return "image_update";
  return null;
}

/** Persoonlijk: nooit naar server- of admin-webhooks. */
const isPersonal = (e: NotifyEvent) => e.kind === "login_new_ip";
/** Te veel ruis voor gedeelde kanalen (alleen wie het zelf aanzet). */
const isQuiet = (e: NotifyEvent) => e.kind === "backup_completed" || e.kind === "deploy_succeeded";

/** Per soort: hoe lang herhalingen samengevoegd worden. */
export const COALESCE_MS: Record<NotifyEvent["kind"], number> = {
  server_crashed: 5 * 60_000,
  disk_warning: 6 * 3_600_000,
  disk_exceeded: 3_600_000,
  backup_failed: 5 * 60_000,
  backup_completed: 60_000,
  install_failed: 5 * 60_000,
  ssl_failed: 3_600_000,
  node_offline: 30 * 60_000,
  node_online: 60_000,
  login_new_ip: 10 * 60_000,
  image_update: 24 * 3_600_000,
  deploy_failed: 60_000,
  deploy_succeeded: 10_000,
};

// ---------- opmaak (kanaalonafhankelijk) ----------

const COLORS = { red: 0xed4245, orange: 0xf0a232, green: 0x3ba55d, grey: 0x95a5a6, blue: 0x5865f2 } as const;
const LEVEL_COLORS: Record<MailLevel, number> = { error: COLORS.red, warning: COLORS.orange, success: COLORS.green, info: COLORS.blue };

const mib = (n: number) => `${Math.round(n / 1048576).toLocaleString("en-US")} MB`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const code = (s: string, n: number) => "```\n" + clip(s.replace(/```/g, "'''"), n - 8) + "\n```";

type Fmt = (s: string) => string;
export interface Message {
  title: string;
  level: MailLevel;
  /** Beschrijving; `strong` markeert namen (vet in Discord), `mono` hostnamen. */
  describe: (strong: Fmt, mono: Fmt) => string;
  fields: (MailField & { inline?: boolean; limit?: number })[];
  /** Pad binnen het panel. */
  link: string | null;
}

const plain = (m: Message) => m.describe((s) => s, (s) => s);

export function buildMessage(e: NotifyEvent, server: Target["server"], opts: { repeats?: number } = {}): Message {
  const sname = server ? clip(server.name, 100) : "";
  const f: Message["fields"] = [];
  let title = "";
  let level: MailLevel = "error";
  let describe: Message["describe"] = () => "";
  let link: string | null = server ? `/servers/${server.uuid}` : null;
  switch (e.kind) {
    case "server_crashed": {
      title = "Server crashed";
      describe = (b) => `${b(sname)} stopped unexpectedly.`;
      f.push({ name: "Reason", value: [e.exitCode === null ? "unknown exit" : `exit code ${e.exitCode}`, e.oom ? "out of memory (OOM-killed)" : null].filter(Boolean).join(", "), inline: true });
      f.push({
        name: "Auto-restart",
        value: e.restart === "restarted" ? `restarting (attempt ${e.attempt})` : e.restart === "gave_up" ? "gave up (too many restarts); the server stays offline" : "off",
        inline: true,
      });
      if (e.restart === "restarted") level = "warning";
      if (e.crashReport) f.push({ name: "Crash report", value: e.crashReport, code: true, limit: 1000 });
      if (e.logTail.length) f.push({ name: "Last console lines", value: e.logTail.slice(-12).join("\n"), code: true, limit: 1000 });
      break;
    }
    case "disk_warning":
      title = "Disk almost full";
      level = "warning";
      describe = (b) => `${b(sname)} uses ${mib(e.usedBytes)} of ${mib(e.limitBytes)} (${e.limitBytes ? Math.round((e.usedBytes * 100) / e.limitBytes) : 0}%).`;
      break;
    case "disk_exceeded":
      title = "Disk limit exceeded";
      describe = (b) => `${b(sname)} is over its disk limit (${mib(e.usedBytes)} of ${mib(e.limitBytes)}). The server was stopped and cannot start until space is freed.`;
      break;
    case "backup_failed":
      title = "Backup failed";
      describe = (b) => `Backup "${clip(e.name, 100)}" of ${b(sname)} failed.`;
      f.push({ name: "Error", value: e.error, code: true, limit: 900 });
      if (server) link = `/servers/${server.uuid}/backups`;
      break;
    case "backup_completed":
      title = "Backup completed";
      level = "success";
      describe = (b) => `Backup "${clip(e.name, 100)}" of ${b(sname)} is complete${e.sizeBytes !== null ? ` (${mib(e.sizeBytes)})` : ""}.`;
      if (server) link = `/servers/${server.uuid}/backups`;
      break;
    case "install_failed":
      title = "Installation failed";
      describe = (b) => `The installation of ${b(sname)} failed.`;
      f.push({ name: "Error", value: e.error, code: true, limit: 900 });
      break;
    case "ssl_failed":
      title = "SSL certificate failed";
      describe = (b, c) => `No certificate could be issued for ${c(clip(e.hostname, 200))}${server ? ` (${b(sname)})` : ""}. Check that the DNS records point to the node.`;
      if (server) link = `/servers/${server.uuid}/domains`;
      break;
    case "node_offline":
      title = "Node offline";
      describe = (b) => `Node ${b(clip(e.nodeName, 100))} is not responding. Servers on this node are unreachable.`;
      if (e.error) f.push({ name: "Error", value: e.error, code: true, limit: 500 });
      link = "/";
      break;
    case "node_online":
      title = "Node back online";
      level = "success";
      describe = (b) => `Node ${b(clip(e.nodeName, 100))} responds again.`;
      link = "/";
      break;
    case "login_new_ip":
      title = "New sign-in to your account";
      level = "info";
      describe = (b) => `Someone signed in to your account from an IP address that was not used before: ${b(clip(e.ip, 60))}. If this was not you, sign out all other sessions and check your Discord account.`;
      if (e.userAgent) f.push({ name: "Browser", value: clip(e.userAgent, 300) });
      link = "/account";
      break;
    case "image_update":
      title = "Image update available";
      level = "info";
      describe = (b) => `A newer image is available for ${b(sname)}.${e.reinstallRequired ? " It requires a reinstall." : ""}`;
      link = "/admin/settings/image-updates";
      break;
    case "deploy_failed":
      title = "Deploy failed";
      describe = (b, c) => `The Git deploy of ${b(sname)} (branch ${c(clip(e.branch, 100))}) failed. The previous version is still online.`;
      if (e.commit) f.push({ name: "Commit", value: e.commit, inline: true });
      f.push({ name: "Error", value: e.error, code: true, limit: 900 });
      if (e.logTail.length) f.push({ name: "Last log lines", value: e.logTail.join("\n"), code: true, limit: 1000 });
      if (server) link = `/servers/${server.uuid}/deploy`;
      break;
    case "deploy_succeeded":
      title = "Deploy succeeded";
      level = "success";
      describe = (b, c) => `${b(sname)} was deployed from branch ${c(clip(e.branch, 100))}.`;
      if (e.commit) f.push({ name: "Commit", value: e.commit, inline: true });
      if (server) link = `/servers/${server.uuid}/deploy`;
      break;
  }
  if (opts.repeats && opts.repeats > 0) f.push({ name: "Repeats", value: `${opts.repeats} more since the previous message (merged)`, inline: true });
  return { title, level, describe, fields: f, link };
}

const md: Fmt = (s) => `**${s.replace(/\*/g, "")}**`;
const tick: Fmt = (s) => `\`${s.replace(/`/g, "")}\``;

/** Embed volgens de Discord-limieten (beschrijving 2000, velden 1024). */
export function buildEmbed(e: NotifyEvent, server: Target["server"], opts: { repeats?: number; now?: Date; panelName?: string; panelUrl?: string } = {}): Embed {
  const m = buildMessage(e, server, opts);
  const base = opts.panelUrl;
  return {
    title: m.title,
    description: clip(m.describe(md, tick), 2000),
    color: LEVEL_COLORS[m.level],
    fields: m.fields.map((x) => ({ name: x.name, value: x.code ? code(x.value, x.limit ?? 1000) : clip(x.value, 1024), ...(x.inline ? { inline: true } : {}) })),
    ...(base && m.link ? { url: `${base}${server ? `/servers/${server.uuid}` : m.link}` } : {}),
    timestamp: (opts.now ?? new Date()).toISOString(),
    footer: { text: opts.panelName ?? "Panel" },
  };
}

/** Mail (onderwerp, HTML, tekst) in panelstijl. */
export function buildEmail(e: NotifyEvent, server: Target["server"], branding: Branding, panelUrl: string, opts: { repeats?: number } = {}) {
  const m = buildMessage(e, server, opts);
  return renderMail(
    {
      subject: `${m.title}${server ? `: ${clip(server.name, 80)}` : ""}`,
      title: m.title,
      level: m.level,
      paragraphs: [plain(m)],
      fields: m.fields.map((x) => ({ name: x.name, value: x.code ? clip(x.value, 4000) : x.value, code: x.code })),
      button: m.link ? { label: server ? "Open in the panel" : "Open the panel", url: `${panelUrl}${m.link}` } : undefined,
      footer: `You get this e-mail because of your notification settings. Change them under Account > Notifications (${panelUrl}/account).`,
    },
    branding,
    panelUrl,
  );
}

// ---------- bezorgen ----------

/** `inline: true` (tests): notify() wacht tot de eerste bezorgpoging klaar is. Anders zie `flushNotify`. */
export const delivery = { inline: false };
const inflight = new Set<Promise<unknown>>();

function track(p: Promise<unknown>): Promise<unknown> {
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
  return p;
}

/** Wacht tot lopende bezorgingen (inclusief samenvattingen) klaar zijn. */
export async function flushNotify(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

interface UserRow {
  id: number;
  blocked: boolean;
  email: string | null;
  emailVerifiedAt: Date | null;
  discordWebhookEnc: string | null;
  notificationPrefs: Record<string, ChannelPrefs>;
}

/** Gebruikers met de kanalen die ze voor deze gebeurtenis willen. */
export async function recipients(e: NotifyEvent, t: Target): Promise<Map<number, { row: UserRow; ch: ChannelPrefs; key: NotificationEvent }>> {
  const db = getDb();
  const userKey = prefKeyOf(e);
  const adminKey = t.admin ? adminPrefKeyOf(e) : null;
  const ids = new Set(t.users ?? []);
  let adminIds = new Set<number>();
  const adminRows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.adminDiscordIds, eq(schema.adminDiscordIds.discordId, schema.users.discordId));
  adminIds = new Set(adminRows.map((a) => a.id));
  if (adminKey) for (const a of adminIds) ids.add(a);
  if (!ids.size) return new Map();
  const rows: UserRow[] = await db
    .select({ id: schema.users.id, blocked: schema.users.blocked, email: schema.users.email, emailVerifiedAt: schema.users.emailVerifiedAt, discordWebhookEnc: schema.users.discordWebhookEnc, notificationPrefs: schema.users.notificationPrefs })
    .from(schema.users)
    .where(inArray(schema.users.id, [...ids]));
  const out = new Map<number, { row: UserRow; ch: ChannelPrefs; key: NotificationEvent }>();
  for (const r of rows) {
    if (r.blocked) continue;
    const isAdmin = adminIds.has(r.id);
    const p = resolvePrefs(r.notificationPrefs, isAdmin);
    const ch: ChannelPrefs = { panel: false, discord: false, email: false };
    const add = (c: ChannelPrefs) => {
      ch.panel ||= c.panel;
      ch.discord ||= c.discord;
      ch.email ||= c.email;
    };
    if (t.users?.includes(r.id)) add(p[userKey]);
    if (adminKey && isAdmin) add(p[adminKey]);
    const key = t.users?.includes(r.id) || !adminKey ? userKey : adminKey;
    if (ch.panel || ch.discord || ch.email) out.set(r.id, { row: r, ch, key });
  }
  return out;
}

let brandingCache: { at: number; b: Branding } | null = null;
async function branding(): Promise<Branding> {
  if (brandingCache && Date.now() - brandingCache.at < 30_000) return brandingCache.b;
  const s = await getSettings();
  const b = { panelName: s.panelName, logoUrl: s.logoUrl, accentColor: s.accentColor };
  brandingCache = { at: Date.now(), b };
  return b;
}

async function deliver(e: NotifyEvent, t: Target, repeats: number): Promise<void> {
  const db = getDb();
  const env = getEnv();
  const users = await recipients(e, t);
  const urls = new Set<string>();
  if (!isPersonal(e) && !isQuiet(e)) {
    for (const h of t.hooks) urls.add(h);
    if (t.admin) {
      const a = await getAdminHook();
      if (a) urls.add(a);
    }
  }
  const emails = new Set<string>();
  const inbox: (typeof schema.notifications.$inferInsert)[] = [];
  const m = buildMessage(e, t.server, { repeats });
  const serverId = t.server ? ((await db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.uuid, t.server.uuid)))[0]?.id ?? null) : null;
  const wantsEmail = [...users.values()].some((u) => u.ch.email && u.row.email && u.row.emailVerifiedAt);
  const smtp = wantsEmail ? await getSmtpConfig().catch(() => null) : null;
  for (const { row, ch, key } of users.values()) {
    if (ch.panel) {
      inbox.push({ userId: row.id, event: key, level: m.level, title: m.title, body: clip(plain(m) + (repeats ? ` (${repeats} more since the previous message)` : ""), 1000), serverId, link: m.link });
    }
    if (ch.discord) {
      const h = dec(row.discordWebhookEnc);
      if (h) urls.add(h);
    }
    if (ch.email && smtp && row.email && row.emailVerifiedAt) emails.add(row.email.toLowerCase());
  }
  if (inbox.length) await db.insert(schema.notifications).values(inbox);
  const items: OutboxItem[] = [];
  if (urls.size || emails.size) {
    const b = await branding();
    if (urls.size) {
      const embed = buildEmbed(e, t.server, { repeats, panelName: b.panelName, panelUrl: env.PANEL_URL });
      for (const u of urls) if (isWebhookUrl(u)) items.push({ channel: "discord", target: u, event: e.kind, payload: { embeds: [embed], username: clip(b.panelName, 80) } });
    }
    if (emails.size) {
      const mail = buildEmail(e, t.server, b, env.PANEL_URL, { repeats });
      for (const to of emails) items.push({ channel: "email", target: to, event: e.kind, payload: mail });
    }
  }
  const ids = await enqueue(items);
  if (ids.length) await deliverDue({ ids });
}

// ---------- ontdubbelen ----------

interface Window {
  until: number;
  repeats: number;
  timer: ReturnType<typeof setTimeout> | null;
  latest: { e: NotifyEvent; t: Target } | null;
}
const windows = new Map<string, Window>();
export const clock: { now: () => number; timer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> } = {
  now: () => Date.now(),
  timer: (fn, ms) => setTimeout(fn, ms),
};

/** Alleen voor tests. */
export function resetNotify(): void {
  for (const w of windows.values()) if (w.timer) clearTimeout(w.timer);
  windows.clear();
  brandingCache = null;
}

function dedupKey(e: NotifyEvent, t: Target): string {
  const id =
    e.kind === "node_offline" || e.kind === "node_online"
      ? e.nodeName
      : e.kind === "ssl_failed"
        ? e.hostname
        : e.kind === "login_new_ip"
          ? `${e.ip}:${(t.users ?? []).join(",")}`
          : (t.server?.uuid ?? "-");
  return `${e.kind}:${id}`;
}

/**
 * Meldt een gebeurtenis. Het eerste bericht gaat meteen; gelijke gebeurtenissen binnen het venster
 * worden geteld en aan het eind van het venster als één samenvattend bericht verstuurd. Gooit nooit.
 * Wacht niet op Discord/SMTP (tenzij `delivery.inline`); zie `flushNotify`.
 */
export async function notify(e: NotifyEvent, t: Target): Promise<void> {
  try {
    const key = dedupKey(e, t);
    const now = clock.now();
    const w = windows.get(key);
    if (w && now < w.until) {
      w.repeats++;
      w.latest = { e, t };
      return;
    }
    const win: Window = { until: now + COALESCE_MS[e.kind], repeats: 0, timer: null, latest: null };
    windows.set(key, win);
    win.timer = clock.timer(() => {
      if (windows.get(key) === win) windows.delete(key);
      if (win.repeats > 0 && win.latest) void track(deliver(win.latest.e, win.latest.t, win.repeats).catch((err) => console.error("[notify] summary:", err)));
    }, COALESCE_MS[e.kind]);
    win.timer.unref?.();
    const p = track(deliver(e, t, 0).catch((err) => console.error(`[notify] ${e.kind}:`, err)));
    if (delivery.inline) await p;
  } catch (err) {
    console.error(`[notify] ${e.kind}:`, err);
  }
}

/** Server + eigenaar uit de database, als ontvangerslijst. */
export async function targetForServer(serverId: number): Promise<Target | null> {
  const [r] = await getDb().select({ s: schema.servers }).from(schema.servers).where(eq(schema.servers.id, serverId));
  if (!r) return null;
  const hook = serverHookOf(r.s);
  return { server: { uuid: r.s.uuid, name: r.s.name }, hooks: hook ? [hook] : [], admin: true, users: [r.s.ownerId] };
}

/** Testbericht; true bij succes. */
export async function sendTest(url: string, what: string): Promise<boolean> {
  const embed: Embed = {
    title: "Test notification",
    description: `This webhook is connected: ${what}.`,
    color: COLORS.green,
    timestamp: new Date().toISOString(),
    footer: { text: "Panel" },
  };
  return (await sendWebhook(url, [embed])).ok;
}
