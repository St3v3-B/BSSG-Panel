/**
 * Meldingssysteem: gebeurtenis → kanalen (inbox, Discord, e-mail), voorkeuren, e-mailverificatie,
 * SMTP via een lokale nep-server, Discord via een lokale nep-server, ontdubbelen, limiet en retries.
 * Er gaat nooit iets naar echte Discord- of mailservers.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_NOTIFICATION_PREFS } from "@panel/api";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as event } from "@/app/api/remote/servers/[uuid]/event/route";
import { getDb, schema } from "./db";
import { loginWithProfile } from "./login";
import { delivery, flushNotify, notify, resetNotify, transport } from "./notify";
import { deliverDue, RATE_PER_HOUR } from "./outbox";
import { FakeSmtp } from "./test/fake-smtp";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const HOOK_A = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789";
const HOOK_S = "https://discord.com/api/webhooks/223456789012345678/serverhookserverhookserverhook0000";
const HOOK_ADMIN = "https://discord.com/api/webhooks/323456789012345678/adminhookadminhookadminhook000000";

// ---------- lokale nep-Discord ----------
let discord: Server;
let discordBase = "";
let hits: { path: string; body: { embeds: { title: string; description?: string; fields?: { name: string; value: string }[] }[] } }[] = [];
let discordStatus = 204;
const realFetch = transport.fetch;

const smtp = new FakeSmtp();
const h = useHarness();
let admin: TestUser, player: TestUser, other: TestUser;
let uuid = "";

beforeAll(async () => {
  discord = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      hits.push({ path: req.url ?? "", body: JSON.parse(b || "{}") });
      res.writeHead(discordStatus).end();
    });
  });
  await new Promise<void>((r) => discord.listen(0, "127.0.0.1", () => r()));
  discordBase = `http://127.0.0.1:${(discord.address() as AddressInfo).port}`;
  await smtp.start();

  admin = await h.user({ discordId: OWNER, admin: true, totp: true });
  player = await h.user({ discordId: "270000000000000001", name: "speler" });
  other = await h.user({ discordId: "270000000000000002", name: "ander" });
  const d = await admin.api.admin.servers.create({
    name: "SMP",
    ownerId: player.id,
    nodeId: h.localNodeId,
    templateId: await h.templateId("testgame"),
    limits: { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 },
    allocationIds: [await h.allocation(25591)],
    variables: {},
    startOnInstall: true,
  });
  uuid = d.uuid;
});
afterAll(async () => {
  await smtp.stop();
  await new Promise<void>((r) => discord.close(() => r()));
});

beforeEach(async () => {
  hits = [];
  discordStatus = 204;
  smtp.mails.length = 0;
  smtp.failData = null;
  smtp.failRcpt = null;
  // Discord-URL's gaan naar de lokale nep-server (zelfde pad).
  transport.fetch = ((url: string, init: RequestInit) => realFetch(`${discordBase}${new URL(url).pathname}`, init)) as typeof fetch;
  transport.sleep = async () => {};
  delivery.inline = true;
  resetNotify();
  await getDb().delete(schema.notificationOutbox);
  await getDb().delete(schema.notifications);
});
afterEach(() => {
  transport.fetch = realFetch;
});

const post = (path: string, body: unknown) => new Request(`http://panel.test${path}`, { method: "POST", headers: { authorization: `Bearer ${h.env.NODE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const crash = { type: "crashed", exit_code: 1, oom: false, log_tail: ["<script>boom</script>"], restart: "disabled", restart_attempt: 0 };
const smtpOn = () => admin.api.admin.smtp.set({ host: "127.0.0.1", port: smtp.port, security: "none", username: "mailer", password: "geheim-wachtwoord", from: "panel@panel.test", fromName: "Test Panel" });
const tokenFrom = (m: { data: string }) => /verify-email\?token=([A-Za-z0-9_-]+)/.exec(FakeSmtp.decoded(m))![1]!;

/** Zet een geverifieerd e-mailadres via de echte flow. */
async function verifiedEmail(u: TestUser, email: string) {
  smtp.mails.length = 0;
  if ((await u.api.account.setEmail({ email })).address === email) return;
  const token = tokenFrom(smtp.mails.at(-1)!);
  await (await h.anon()).auth.verifyEmail({ token });
  smtp.mails.length = 0;
}

describe("SMTP-instellingen (admin)", () => {
  it("opslaan zonder het wachtwoord terug te geven, versleuteld in de DB, testmail en fouten", async () => {
    await expect(player.api.admin.smtp.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await admin.api.admin.smtp.get()).host).toBeNull();
    expect(await admin.api.admin.smtp.test({ to: "a@panel.test" })).toEqual({ ok: false, error: "SMTP is not configured" });
    const s = await smtpOn();
    expect(s).toMatchObject({ host: "127.0.0.1", port: smtp.port, security: "none", username: "mailer", passwordSet: true, from: "panel@panel.test" });
    expect(JSON.stringify(s)).not.toContain("geheim");
    const rows = await getDb().select().from(schema.settings);
    expect(JSON.stringify(rows)).not.toContain("geheim-wachtwoord");
    expect(rows.find((r) => r.key === "smtp_password_enc")!.value).toMatch(/^v1:/);

    expect(await admin.api.admin.smtp.test({ to: "Admin@Panel.test" })).toEqual({ ok: true, error: null });
    const m = smtp.mails.at(-1)!;
    expect(m.to).toEqual(["admin@panel.test"]);
    expect(m.auth).toEqual({ user: "mailer", pass: "geheim-wachtwoord" });
    expect(m.data).toMatch(/From: "?Test Panel"? <panel@panel.test>/);
    expect(m.data).toContain("text/html");
    expect(m.data).toContain("text/plain");

    // wachtwoord ongewijzigd laten (weggelaten) en fout wachtwoord op de server
    smtp.password = "iets-anders";
    await admin.api.admin.smtp.set({ host: "127.0.0.1", port: smtp.port, security: "none", username: "mailer", from: "panel@panel.test", fromName: null });
    expect((await admin.api.admin.smtp.get()).passwordSet).toBe(true);
    const bad = await admin.api.admin.smtp.test({ to: "a@panel.test" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/EAUTH|535/);
    smtp.password = null;
    await smtpOn();
  });
});

describe("e-mailadres met verificatielink", () => {
  it("zonder SMTP: SMTP_NOT_CONFIGURED", async () => {
    await admin.api.admin.smtp.set({ host: null, port: 587, security: "starttls", username: null, from: null, fromName: null });
    await expect(player.api.account.setEmail({ email: "speler@panel.test" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "SMTP_NOT_CONFIGURED" });
    expect((await player.api.account.notificationSettings()).emailAvailable).toBe(false);
    await smtpOn();
  });

  it("link per mail, pas na de klik actief, eenmalig, ongeldige token geweigerd", async () => {
    const st = await player.api.account.setEmail({ email: "Speler@Panel.test" });
    expect(st).toEqual({ address: null, pending: "speler@panel.test" });
    const m = smtp.mails.at(-1)!;
    expect(m.to).toEqual(["speler@panel.test"]);
    expect(m.subject).toContain("Confirm your e-mail address");
    const token = tokenFrom(m);
    // het token staat niet leesbaar in de DB
    const rows = await getDb().select().from(schema.emailVerifications).where(eq(schema.emailVerifications.userId, player.id));
    expect(JSON.stringify(rows)).not.toContain(token);
    const anon = await h.anon();
    await expect(anon.auth.verifyEmail({ token: "x".repeat(43) })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "INVALID_TOKEN" });
    expect(await anon.auth.verifyEmail({ token })).toEqual({ ok: true, email: "speler@panel.test" });
    await expect(anon.auth.verifyEmail({ token })).rejects.toMatchObject({ message: "INVALID_TOKEN" });
    expect((await player.api.account.notificationSettings()).email).toEqual({ address: "speler@panel.test", pending: null });
    // testmail naar het geverifieerde adres
    smtp.mails.length = 0;
    await player.api.account.testEmail();
    expect(smtp.mails[0]!.to).toEqual(["speler@panel.test"]);
  });

  it("verlopen link werkt niet; limiet op verificatiemails; verwijderen", async () => {
    await other.api.account.setEmail({ email: "ander@panel.test" });
    const token = tokenFrom(smtp.mails.at(-1)!);
    await getDb().update(schema.emailVerifications).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.emailVerifications.userId, other.id));
    await expect((await h.anon()).auth.verifyEmail({ token })).rejects.toMatchObject({ message: "INVALID_TOKEN" });
    for (let i = 0; i < 4; i++) await other.api.account.resendEmailVerification().catch(() => other.api.account.setEmail({ email: "ander@panel.test" }));
    await expect(other.api.account.setEmail({ email: "ander2@panel.test" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(await other.api.account.setEmail({ email: null })).toEqual({ address: null, pending: null });
    await expect(other.api.account.testEmail()).rejects.toMatchObject({ message: "EMAIL_NOT_VERIFIED" });
  });
});

describe("routering gebeurtenis → kanalen", () => {
  beforeAll(async () => {
    await verifiedEmail(player, "speler@panel.test");
    await player.api.account.setWebhook({ url: HOOK_A });
    await player.api.servers.updateNotifications({ uuid, webhookUrl: HOOK_S, autoRestart: false, autoRestartMax: 3 });
    await admin.api.admin.notifications.set({ url: HOOK_ADMIN });
  });
  beforeEach(async () => {
    await player.api.account.setNotificationPrefs({ prefs: DEFAULT_NOTIFICATION_PREFS });
    smtp.mails.length = 0;
  });

  it("crash: inbox, eigen webhook, serverwebhook, admin-webhook en e-mail (standaard)", async () => {
    expect((await event(post(`/api/remote/servers/${uuid}/event`, crash), params({ uuid }))).status).toBe(204);
    expect(hits.map((x) => x.path).sort()).toEqual([HOOK_A, HOOK_S, HOOK_ADMIN].map((u) => new URL(u).pathname).sort());
    expect(smtp.mails).toHaveLength(1);
    const mail = FakeSmtp.decoded(smtp.mails[0]!);
    expect(smtp.mails[0]!.subject).toContain("Server crashed: SMP");
    // HTML ontsnapt, met branding en knop; platte tekst erbij
    const html = mail.slice(mail.indexOf("Content-Type: text/html"));
    const text = mail.slice(mail.indexOf("Content-Type: text/plain"), mail.indexOf("Content-Type: text/html"));
    expect(html).toContain("&lt;script&gt;boom&lt;/script&gt;");
    expect(html).not.toContain("<script>boom");
    expect(text).toContain("Server crashed");
    expect(mail).toContain(`/servers/${uuid}`);
    expect(mail).toContain("Open in the panel");
    const inbox = await player.api.inbox.list({ limit: 10 });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ event: "server_crashed", level: "error", title: "Server crashed", server: { uuid, name: "SMP" }, link: `/servers/${uuid}`, readAt: null });
    expect((await player.api.inbox.unreadCount()).count).toBe(1);
    // de admin krijgt crashes van anderen niet in zijn eigen inbox (alleen de admin-webhook)
    expect((await admin.api.inbox.unreadCount()).count).toBe(0);
    // een ander ziet het niet en kan het niet als gelezen markeren
    expect((await other.api.inbox.list({ limit: 10 })).items).toHaveLength(0);
    await other.api.inbox.markRead({ ids: [inbox.items[0]!.id] });
    expect((await player.api.inbox.unreadCount()).count).toBe(1);
    await player.api.inbox.markRead({});
    expect((await player.api.inbox.unreadCount()).count).toBe(0);
  });

  it("voorkeuren: kanalen per gebeurtenis uitzetten", async () => {
    const st = await player.api.account.setNotificationPrefs({ prefs: { server_crashed: { panel: false, discord: false, email: false } } });
    expect(st.prefs.server_crashed).toEqual({ panel: false, discord: false, email: false });
    expect(st.prefs.disk).toEqual(DEFAULT_NOTIFICATION_PREFS.disk);
    // niet-admins zien admin-gebeurtenissen niet aan
    expect(st.prefs.node_offline).toEqual({ panel: false, discord: false, email: false });
    await event(post(`/api/remote/servers/${uuid}/event`, crash), params({ uuid }));
    // alleen nog de server- en admin-webhook (geen voorkeuren)
    expect(hits.map((x) => x.path).sort()).toEqual([HOOK_S, HOOK_ADMIN].map((u) => new URL(u).pathname).sort());
    expect(smtp.mails).toHaveLength(0);
    expect((await player.api.inbox.unreadCount()).count).toBe(0);
    // disk: alleen e-mail
    await player.api.account.setNotificationPrefs({ prefs: { disk: { panel: false, discord: false, email: true } } });
    hits = [];
    await event(post(`/api/remote/servers/${uuid}/event`, { type: "disk_warning", disk_bytes: 950 << 20, disk_limit_bytes: 1024 << 20 }), params({ uuid }));
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0]!.subject).toContain("Disk almost full");
    expect(hits.some((x) => x.path === new URL(HOOK_A).pathname)).toBe(false);
  });

  it("backup geslaagd: standaard uit, en nooit naar gedeelde webhooks", async () => {
    const [b] = await getDb().select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.uuid, uuid));
    const [bk] = await getDb().insert(schema.backups).values({ serverId: b!.id, name: "nacht", s3Key: "k", status: "running" }).returning();
    const { POST: backupReport } = await import("@/app/api/remote/backups/[backup_id]/route");
    await backupReport(post(`/api/remote/backups/${bk!.id}`, { successful: true, sha256: "a".repeat(64), size_bytes: 5 << 20 }), params({ backup_id: String(bk!.id) }));
    await flushNotify();
    expect(hits).toHaveLength(0);
    expect(smtp.mails).toHaveLength(0);
    await player.api.account.setNotificationPrefs({ prefs: { backup_completed: { panel: true, discord: true, email: false } } });
    resetNotify();
    const [bk2] = await getDb().insert(schema.backups).values({ serverId: b!.id, name: "middag", s3Key: "k2", status: "running" }).returning();
    await backupReport(post(`/api/remote/backups/${bk2!.id}`, { successful: true, sha256: "b".repeat(64), size_bytes: 5 << 20 }), params({ backup_id: String(bk2!.id) }));
    expect(hits.map((x) => x.path)).toEqual([new URL(HOOK_A).pathname]);
    expect(hits[0]!.body.embeds[0]!.title).toBe("Backup completed");
    expect((await player.api.inbox.list({ limit: 5 })).items[0]!.title).toBe("Backup completed");
  });

  it("image-update: alleen admins (voorkeur) en de admin-webhook, alleen bij de overgang", async () => {
    const { storeImageReport } = await import("./image-updates");
    await storeImageReport([{ uuid, update_available: true, reinstall_required: false, checked_at: new Date().toISOString() }]);
    await flushNotify();
    expect(hits.map((x) => x.path)).toEqual([new URL(HOOK_ADMIN).pathname]);
    expect((await admin.api.inbox.list({ limit: 5 })).items[0]).toMatchObject({ event: "image_update", title: "Image update available" });
    expect((await player.api.inbox.unreadCount()).count).toBe(0);
    hits = [];
    resetNotify();
    await storeImageReport([{ uuid, update_available: true, reinstall_required: false, checked_at: new Date().toISOString() }]);
    expect(hits).toHaveLength(0);
  });

  it("nieuwe login vanaf een onbekend IP: alleen de gebruiker zelf, niet de eerste login", async () => {
    const req = (ip: string) => new Request("http://panel.test/api/auth/test/login", { headers: { "x-forwarded-for": ip, "user-agent": "Firefox/140" } });
    const profile = { discordId: "270000000000000009", name: "nieuw", avatarUrl: null };
    await loginWithProfile(profile, req("198.51.100.1"), "test");
    await flushNotify();
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.discordId, profile.discordId));
    expect((await getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, u!.id))).length).toBe(0);
    await loginWithProfile(profile, req("198.51.100.1"), "test");
    await flushNotify();
    expect((await getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, u!.id))).length).toBe(0);
    await loginWithProfile(profile, req("203.0.113.77"), "test");
    await flushNotify();
    const n = await getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, u!.id));
    expect(n).toHaveLength(1);
    expect(n[0]!).toMatchObject({ event: "login_new_ip", title: "New sign-in to your account" });
    expect(n[0]!.body).toContain("203.0.113.77");
    // nooit naar de admin-webhook
    expect(hits).toHaveLength(0);
  });
});

describe("ontdubbelen, limiet en wachtrij", () => {
  beforeAll(async () => {
    await player.api.account.setNotificationPrefs({ prefs: DEFAULT_NOTIFICATION_PREFS });
  });

  it("crashloop: één mail en één webhookbericht per ontvanger binnen het venster", async () => {
    for (let i = 0; i < 25; i++) await notify({ kind: "server_crashed", exitCode: 1, oom: false, logTail: [], crashReport: null, restart: "restarted", attempt: i }, { server: { uuid, name: "SMP" }, hooks: [], admin: false, users: [player.id] });
    await flushNotify();
    expect(smtp.mails).toHaveLength(1);
    expect(hits).toHaveLength(1);
    expect((await player.api.inbox.unreadCount()).count).toBe(1);
  });

  it("limiet per ontvanger per uur, ook zonder het geheugen-venster (bv. na een herstart)", async () => {
    for (let i = 0; i < RATE_PER_HOUR.email + 5; i++) {
      resetNotify(); // alsof het panel herstart: geen samenvoeg-venster
      await notify({ kind: "disk_exceeded", usedBytes: 2, limitBytes: 1 }, { server: { uuid, name: "SMP" }, hooks: [], admin: false, users: [player.id] });
    }
    await flushNotify();
    expect(smtp.mails).toHaveLength(RATE_PER_HOUR.email);
    const dropped = await getDb().select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.channel, "email"), eq(schema.notificationOutbox.status, "dropped")));
    expect(dropped).toHaveLength(5);
  });

  it("tijdelijke fout: opnieuw proberen met backoff; permanente fout: opgeven", async () => {
    smtp.failData = "451 4.3.0 try again later";
    discordStatus = 503;
    await notify({ kind: "backup_failed", name: "x", error: "s3" }, { server: { uuid, name: "SMP" }, hooks: [], admin: false, users: [player.id] });
    await flushNotify();
    expect(smtp.mails).toHaveLength(0);
    let rows = await getDb().select().from(schema.notificationOutbox);
    expect(rows.map((r) => [r.channel, r.status, r.attempts]).sort()).toEqual([["discord", "pending", 1], ["email", "pending", 1]]);
    expect(rows.every((r) => r.nextAttemptAt.getTime() > Date.now() + 20_000)).toBe(true);
    // nog niet aan de beurt
    expect(await deliverDue()).toBe(0);
    discordStatus = 204;
    await getDb().update(schema.notificationOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) });
    expect(await deliverDue()).toBe(2);
    expect(smtp.mails).toHaveLength(1);
    rows = await getDb().select().from(schema.notificationOutbox);
    expect(rows.every((r) => r.status === "sent" && r.attempts === 2)).toBe(true);
    // permanente fout (550) en verwijderde webhook (404): meteen failed
    smtp.failRcpt = "550 5.1.1 no such user";
    discordStatus = 404;
    resetNotify();
    await notify({ kind: "backup_failed", name: "y", error: "s3" }, { server: { uuid, name: "SMP" }, hooks: [], admin: false, users: [player.id] });
    await flushNotify();
    rows = await getDb().select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.status, "failed"));
    expect(rows.map((r) => r.channel).sort()).toEqual(["discord", "email"]);
    // het doel staat versleuteld in de wachtrij
    expect(JSON.stringify(rows)).not.toContain("speler@panel.test");
    expect(JSON.stringify(rows)).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("zonder inline wacht notify() niet op SMTP/Discord", async () => {
    delivery.inline = false;
    await notify({ kind: "install_failed", error: "exit 1" }, { server: { uuid, name: "SMP" }, hooks: [], admin: false, users: [player.id] });
    await flushNotify();
    expect(hits.some((x) => x.body.embeds[0]!.title === "Installation failed")).toBe(true);
  });
});
