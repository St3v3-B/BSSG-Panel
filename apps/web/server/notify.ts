/**
 * Meldingen via Discord-webhooks: embeds opmaken, ontdubbelen, versturen met retries.
 *
 * Ontvangers per gebeurtenis: de webhook van de server, de webhook van de eigenaar en de
 * admin-brede webhook (zelfde URL's tellen één keer). Node offline gaat alleen naar de admin.
 * Opslag: `servers.discord_webhook_enc`, `users.discord_webhook_enc`, en settings-sleutel
 * `admin_webhook_enc` (alles versleuteld; het token zit in de URL).
 */
import { DISCORD_WEBHOOK_RE, type WebhookStatus } from "@panel/api";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getEnv } from "./env";
import { decrypt, encrypt } from "./lib/crypto";

// ---------- URL's ----------

export const isWebhookUrl = (u: string) => DISCORD_WEBHOOK_RE.test(u);

/** Hint zonder het token: `…/webhooks/<id>/…abcd`. */
export function hookStatus(url: string | null | undefined): WebhookStatus {
  if (!url) return { set: false, hint: null };
  const m = /\/webhooks\/(\d+)\/(.+)$/.exec(url);
  return { set: true, hint: m ? `…/webhooks/${m[1]}/…${m[2]!.slice(-4)}` : "…" };
}

const dec = (enc: string | null | undefined): string | null => {
  if (!enc) return null;
  try {
    return decrypt(enc);
  } catch {
    return null;
  }
};

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

// ---------- gebeurtenissen en opmaak ----------

export type NotifyEvent =
  | { kind: "server_crashed"; exitCode: number | null; oom: boolean; logTail: string[]; crashReport: string | null; restart: "restarted" | "gave_up" | "disabled"; attempt: number }
  | { kind: "disk_warning"; usedBytes: number; limitBytes: number }
  | { kind: "disk_exceeded"; usedBytes: number; limitBytes: number }
  | { kind: "backup_failed"; name: string; error: string }
  | { kind: "install_failed"; error: string }
  | { kind: "ssl_failed"; hostname: string }
  | { kind: "node_offline"; nodeName: string; error: string | null }
  | { kind: "node_online"; nodeName: string };

export interface Target {
  /** Voor de titel en de link; null bij node-gebeurtenissen. */
  server: { uuid: string; name: string } | null;
  /** Webhooks van server en eigenaar (al ontsleuteld). */
  hooks: string[];
  /** Ook naar de admin-webhook. */
  admin: boolean;
}

const COLORS = { red: 0xed4245, orange: 0xf0a232, green: 0x3ba55d, grey: 0x95a5a6 } as const;

/** Per soort: hoe lang herhalingen samengevoegd worden. */
export const COALESCE_MS: Record<NotifyEvent["kind"], number> = {
  server_crashed: 5 * 60_000,
  disk_warning: 6 * 3_600_000,
  disk_exceeded: 3_600_000,
  backup_failed: 5 * 60_000,
  install_failed: 5 * 60_000,
  ssl_failed: 3_600_000,
  node_offline: 30 * 60_000,
  node_online: 60_000,
};

const mib = (n: number) => `${Math.round(n / 1048576).toLocaleString("en-US")} MB`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const code = (s: string, n: number) => "```\n" + clip(s.replace(/```/g, "'''"), n - 8) + "\n```";

export interface Embed {
  title: string;
  description?: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  url?: string;
  timestamp: string;
  footer: { text: string };
}

export function buildEmbed(e: NotifyEvent, server: Target["server"], opts: { repeats?: number; now?: Date; panelName?: string; panelUrl?: string } = {}): Embed {
  const name = server ? `**${clip(server.name, 100)}**` : "";
  const f: NonNullable<Embed["fields"]> = [];
  let title = "";
  let description = "";
  let color: number = COLORS.red;
  switch (e.kind) {
    case "server_crashed": {
      title = "Server crashed";
      description = `${name} stopped unexpectedly.`;
      f.push({ name: "Reason", value: [e.exitCode === null ? "unknown exit" : `exit code ${e.exitCode}`, e.oom ? "out of memory (OOM-killed)" : null].filter(Boolean).join(", "), inline: true });
      f.push({
        name: "Auto-restart",
        value: e.restart === "restarted" ? `restarting (attempt ${e.attempt})` : e.restart === "gave_up" ? "gave up (too many restarts); the server stays offline" : "off",
        inline: true,
      });
      if (e.restart === "restarted") color = COLORS.orange;
      if (e.crashReport) f.push({ name: "Crash report", value: code(e.crashReport, 1000) });
      if (e.logTail.length) f.push({ name: "Last console lines", value: code(e.logTail.slice(-12).join("\n"), 1000) });
      break;
    }
    case "disk_warning":
      title = "Disk almost full";
      color = COLORS.orange;
      description = `${name} uses ${mib(e.usedBytes)} of ${mib(e.limitBytes)} (${e.limitBytes ? Math.round((e.usedBytes * 100) / e.limitBytes) : 0}%).`;
      break;
    case "disk_exceeded":
      title = "Disk limit exceeded";
      description = `${name} is over its disk limit (${mib(e.usedBytes)} of ${mib(e.limitBytes)}). The server was stopped and cannot start until space is freed.`;
      break;
    case "backup_failed":
      title = "Backup failed";
      description = `Backup "${clip(e.name, 100)}" of ${name} failed.`;
      f.push({ name: "Error", value: code(e.error, 900) });
      break;
    case "install_failed":
      title = "Installation failed";
      description = `The installation of ${name} failed.`;
      f.push({ name: "Error", value: code(e.error, 900) });
      break;
    case "ssl_failed":
      title = "SSL certificate failed";
      description = `No certificate could be issued for \`${clip(e.hostname, 200)}\`${server ? ` (${name})` : ""}. Check that the DNS records point to the node.`;
      break;
    case "node_offline":
      title = "Node offline";
      description = `Node **${clip(e.nodeName, 100)}** is not responding.`;
      if (e.error) f.push({ name: "Error", value: code(e.error, 500) });
      break;
    case "node_online":
      title = "Node back online";
      color = COLORS.green;
      description = `Node **${clip(e.nodeName, 100)}** responds again.`;
      break;
  }
  if (opts.repeats && opts.repeats > 0) f.push({ name: "Repeats", value: `${opts.repeats} more since the previous message (merged)`, inline: true });
  const base = opts.panelUrl;
  return {
    title,
    description: clip(description, 2000),
    color,
    fields: f,
    ...(base && server ? { url: `${base}/servers/${server.uuid}` } : {}),
    timestamp: (opts.now ?? new Date()).toISOString(),
    footer: { text: opts.panelName ?? "Panel" },
  };
}

// ---------- versturen ----------

export interface SendResult {
  ok: boolean;
  status: number | null;
  attempts: number;
}

/** Vervangbaar in tests: geen echte Discord-aanroepen. */
export const transport: { fetch: typeof fetch; sleep: (ms: number) => Promise<void> } = {
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const MAX_ATTEMPTS = 3;

/**
 * POST naar de webhook. 429 → wacht `retry_after` (max 10 s); 5xx of netwerkfout → backoff
 * (1 s, 2 s); andere 4xx (ongeldige of verwijderde webhook) → meteen opgeven. Geen redirects.
 */
export async function sendWebhook(url: string, embeds: Embed[], opts: { username?: string } = {}): Promise<SendResult> {
  if (!isWebhookUrl(url)) return { ok: false, status: null, attempts: 0 };
  const body = JSON.stringify({ username: opts.username ?? "Panel", embeds, allowed_mentions: { parse: [] } });
  let status: number | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let wait = 1000 * 2 ** (attempt - 1);
    try {
      const res = await transport.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      status = res.status;
      if (res.ok) return { ok: true, status, attempts: attempt };
      if (res.status === 429) {
        const j = (await res.json().catch(() => null)) as { retry_after?: number } | null;
        wait = Math.min(10_000, Math.max(0, (j?.retry_after ?? 1) * 1000));
      } else if (res.status < 500) {
        return { ok: false, status, attempts: attempt };
      }
    } catch {
      status = null;
    }
    if (attempt < MAX_ATTEMPTS) await transport.sleep(wait);
  }
  return { ok: false, status, attempts: MAX_ATTEMPTS };
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
}

function dedupKey(e: NotifyEvent, t: Target): string {
  const id = e.kind === "node_offline" || e.kind === "node_online" ? e.nodeName : e.kind === "ssl_failed" ? e.hostname : (t.server?.uuid ?? "-");
  return `${e.kind}:${id}`;
}

async function deliver(e: NotifyEvent, t: Target, repeats: number): Promise<void> {
  const urls = new Set(t.hooks);
  if (t.admin) {
    const a = await getAdminHook();
    if (a) urls.add(a);
  }
  if (!urls.size) return;
  const env = getEnv();
  const [name] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, "panel_name"));
  const embed = buildEmbed(e, t.server, { repeats, panelName: typeof name?.value === "string" ? name.value : "Panel", panelUrl: env.PANEL_URL });
  await Promise.all(
    [...urls].map(async (u) => {
      const r = await sendWebhook(u, [embed]);
      if (!r.ok) console.warn(`[notify] ${e.kind}: webhook failed (status ${r.status ?? "network"}, ${r.attempts} attempts)`);
    }),
  );
}

/**
 * Meldt een gebeurtenis. Het eerste bericht gaat meteen; gelijke gebeurtenissen (zelfde soort en
 * server/domein/node) binnen het venster worden geteld en aan het eind van het venster als één
 * samenvattend bericht verstuurd. Gooit nooit.
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
      if (win.repeats > 0 && win.latest) void deliver(win.latest.e, win.latest.t, win.repeats).catch((err) => console.error("[notify] summary:", err));
    }, COALESCE_MS[e.kind]);
    win.timer.unref?.();
    await deliver(e, t, 0);
  } catch (err) {
    console.error(`[notify] ${e.kind}:`, err);
  }
}

/** Server + eigenaar uit de database, als ontvangerslijst. */
export async function targetForServer(serverId: number): Promise<Target | null> {
  const [r] = await getDb()
    .select({ s: schema.servers, owner: schema.users.discordWebhookEnc })
    .from(schema.servers)
    .innerJoin(schema.users, eq(schema.users.id, schema.servers.ownerId))
    .where(eq(schema.servers.id, serverId));
  if (!r) return null;
  return {
    server: { uuid: r.s.uuid, name: r.s.name },
    hooks: [serverHookOf(r.s), dec(r.owner)].filter((x): x is string => !!x),
    admin: true,
  };
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
