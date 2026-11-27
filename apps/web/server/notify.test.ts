import { DISCORD_WEBHOOK_RE, WebhookUrl } from "@panel/api";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as event } from "@/app/api/remote/servers/[uuid]/event/route";
import { POST as backupReport } from "@/app/api/remote/backups/[backup_id]/route";
import { POST as installReport } from "@/app/api/remote/servers/[uuid]/install/route";
import { getDb, schema } from "./db";
import { checkNodes, checkSsl, resetMonitor } from "./monitor";
import { buildEmbed, clock, notify, resetNotify, sendWebhook, transport, type NotifyEvent } from "./notify";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const GOOD = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789";
const GOOD2 = "https://discordapp.com/api/v10/webhooks/223456789012345678/ABCDEFGHIJKLMNOPQRSTUVWXYZ-_0123";
const GOOD3 = "https://discord.com/api/webhooks/323456789012345678/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

interface Sent {
  url: string;
  body: { embeds: { title: string; fields?: { name: string; value: string }[]; description?: string }[]; allowed_mentions: unknown };
}
let sent: Sent[] = [];
let respond: (url: string, n: number) => { status: number; json?: unknown } = () => ({ status: 204 });
let sleeps: number[] = [];
const realFetch = transport.fetch;
const realSleep = transport.sleep;
const counts = new Map<string, number>();

beforeEach(() => {
  sent = [];
  sleeps = [];
  counts.clear();
  respond = () => ({ status: 204 });
  transport.fetch = (async (url: string, init: RequestInit) => {
    const n = (counts.get(url) ?? 0) + 1;
    counts.set(url, n);
    sent.push({ url, body: JSON.parse(String(init.body)) });
    const r = respond(url, n);
    return new Response(r.json ? JSON.stringify(r.json) : null, { status: r.status });
  }) as unknown as typeof fetch;
  transport.sleep = async (ms) => void sleeps.push(ms);
  resetNotify();
  resetMonitor();
});
afterEach(() => {
  transport.fetch = realFetch;
  transport.sleep = realSleep;
  clock.now = () => Date.now();
  clock.timer = (fn, ms) => setTimeout(fn, ms);
});

describe("webhook-URL validatie", () => {
  it("accepteert alleen discord.com / discordapp.com webhooks", () => {
    for (const u of [GOOD, GOOD2, GOOD3]) expect(WebhookUrl.safeParse(u).success).toBe(true);
    for (const u of [
      "http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
      "https://evil.test/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
      "https://discord.com.evil.test/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
      "https://discord.com@evil.test/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
      "https://evil.test/https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
      "https://discord.com/api/webhooks/abc/abcdefghijklmnopqrstuvwxyz",
      "https://discord.com/api/webhooks/123456789012345678/abc",
      "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz?x=1",
      "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz/extra",
      "https://127.0.0.1/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
      "",
    ])
      expect(DISCORD_WEBHOOK_RE.test(u), u).toBe(false);
  });
});

describe("opmaak", () => {
  const crash: NotifyEvent = { kind: "server_crashed", exitCode: 137, oom: true, logTail: Array.from({ length: 30 }, (_, i) => `regel ${i}`), crashReport: "---- Crash ----\nx", restart: "gave_up", attempt: 3 };
  it("crash-embed met reden, auto-restart en logregels", () => {
    const e = buildEmbed(crash, { uuid: "u", name: "SMP" });
    expect(e.title).toBe("Server crashed");
    expect(e.color).toBe(0xed4245);
    const f = Object.fromEntries(e.fields!.map((x) => [x.name, x.value]));
    expect(f["Reason"]).toBe("exit code 137, out of memory (OOM-killed)");
    expect(f["Auto-restart"]).toContain("gave up");
    expect(f["Last console lines"]).toContain("regel 29");
    expect(f["Last console lines"]).not.toContain("regel 5\n");
    expect(f["Crash report"]).toContain("---- Crash ----");
    expect(buildEmbed({ ...crash, restart: "restarted", attempt: 2 }, { uuid: "u", name: "SMP" }).fields!.find((x) => x.name === "Auto-restart")!.value).toBe("restarting (attempt 2)");
  });
  it("houdt zich aan de Discord-limieten en breekt codeblokken niet", () => {
    const e = buildEmbed({ ...crash, logTail: ["x".repeat(5000), "```evil```"], crashReport: "y".repeat(9000) }, { uuid: "u", name: "n".repeat(500) });
    for (const f of e.fields!) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(e.description!.length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(e)).not.toContain("```evil");
  });
  it("overige soorten", () => {
    const s = { uuid: "u", name: "Site" };
    expect(buildEmbed({ kind: "disk_warning", usedBytes: 950 << 20, limitBytes: 1024 << 20 }, s).description).toContain("93%");
    expect(buildEmbed({ kind: "disk_exceeded", usedBytes: 1100 << 20, limitBytes: 1024 << 20 }, s).title).toBe("Disk limit exceeded");
    expect(buildEmbed({ kind: "ssl_failed", hostname: "x.panel.test" }, s).description).toContain("x.panel.test");
    expect(buildEmbed({ kind: "node_offline", nodeName: "node1", error: "timeout" }, null).fields![0]!.value).toContain("timeout");
    expect(buildEmbed({ kind: "backup_failed", name: "nacht", error: "s3" }, s).title).toBe("Backup failed");
    expect(buildEmbed({ kind: "install_failed", error: "exit 1" }, s).title).toBe("Installation failed");
  });
});

describe("versturen met retries", () => {
  const embed = buildEmbed({ kind: "install_failed", error: "x" }, null);
  it("slaagt in één keer en zet geen pings aan", async () => {
    const r = await sendWebhook(GOOD, [embed]);
    expect(r).toEqual({ ok: true, status: 204, attempts: 1 });
    expect(sent[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });
  it("probeert 5xx opnieuw met backoff", async () => {
    respond = (_u, n) => ({ status: n < 3 ? 502 : 204 });
    expect(await sendWebhook(GOOD, [embed])).toEqual({ ok: true, status: 204, attempts: 3 });
    expect(sleeps).toEqual([1000, 2000]);
  });
  it("wacht retry_after bij 429 (max 10 s)", async () => {
    respond = (_u, n) => (n === 1 ? { status: 429, json: { retry_after: 2.5 } } : n === 2 ? { status: 429, json: { retry_after: 99 } } : { status: 204 });
    expect((await sendWebhook(GOOD, [embed])).ok).toBe(true);
    expect(sleeps).toEqual([2500, 10_000]);
  });
  it("geeft op bij 404 (verwijderde webhook) zonder herhalen, en na drie pogingen", async () => {
    respond = () => ({ status: 404 });
    expect(await sendWebhook(GOOD, [embed])).toEqual({ ok: false, status: 404, attempts: 1 });
    respond = () => ({ status: 500 });
    expect(await sendWebhook(GOOD, [embed])).toEqual({ ok: false, status: 500, attempts: 3 });
  });
  it("netwerkfout telt als poging; een niet-Discord-URL wordt nooit aangeroepen", async () => {
    transport.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect((await sendWebhook(GOOD, [embed])).attempts).toBe(3);
    sent = [];
    transport.fetch = realFetch;
    expect(await sendWebhook("https://evil.test/x", [embed])).toEqual({ ok: false, status: null, attempts: 0 });
  });
});

const h = useHarness();
let admin: TestUser, player: TestUser;
let uuid = "";
let serverId = 0;

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, admin: true, totp: true });
  player = await h.user({ discordId: "260000000000000001", name: "speler" });
  const d = await admin.api.admin.servers.create({
    name: "SMP",
    ownerId: player.id,
    nodeId: h.localNodeId,
    templateId: await h.templateId("testgame"),
    limits: { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 },
    allocationIds: [await h.allocation(25581)],
    variables: {},
    startOnInstall: true,
  });
  uuid = d.uuid;
  serverId = (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid)))[0]!.id;
});

const post = (path: string, body: unknown) => new Request(`http://panel.test${path}`, { method: "POST", headers: { authorization: `Bearer ${h.env.NODE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const crashBody = { type: "crashed", exit_code: 1, oom: false, log_tail: ["boom"], restart: "restarted", restart_attempt: 1 };

describe("webhooks instellen (tRPC)", () => {
  it("account: valideren, opslaan versleuteld, nooit de volledige URL terug, test, verwijderen", async () => {
    expect(await player.api.account.webhook()).toEqual({ set: false, hint: null });
    await expect(player.api.account.setWebhook({ url: "https://evil.test/x" })).rejects.toThrow();
    await expect(player.api.account.testWebhook()).rejects.toMatchObject({ message: "NO_WEBHOOK" });
    const st = await player.api.account.setWebhook({ url: GOOD });
    expect(st.set).toBe(true);
    expect(JSON.stringify(st)).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    const [row] = await getDb().select().from(schema.users).where(eq(schema.users.id, player.id));
    expect(row!.discordWebhookEnc).toMatch(/^v1:/);
    expect(row!.discordWebhookEnc).not.toContain("webhooks");
    await player.api.account.testWebhook();
    expect(sent.at(-1)!.url).toBe(GOOD);
    expect(sent.at(-1)!.body.embeds[0]!.title).toBe("Test notification");
    respond = () => ({ status: 404 });
    await expect(player.api.account.testWebhook()).rejects.toMatchObject({ message: "WEBHOOK_FAILED" });
    respond = () => ({ status: 204 });
    expect(await player.api.account.setWebhook({ url: null })).toEqual({ set: false, hint: null });
  });

  it("server: alleen eigenaar; auto-restart gaat in de spec naar de daemon", async () => {
    const stranger = await h.user({ discordId: "260000000000000009", name: "vreemd" });
    await expect(stranger.api.servers.notifications({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(stranger.api.servers.updateNotifications({ uuid, autoRestart: true, autoRestartMax: 3 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.daemon.requests.length = 0;
    const r = await player.api.servers.updateNotifications({ uuid, webhookUrl: GOOD2, autoRestart: true, autoRestartMax: 4 });
    expect(r).toMatchObject({ autoRestart: true, autoRestartMax: 4, webhook: { set: true } });
    expect(h.daemon.servers.get(uuid)!.spec.auto_restart).toEqual({ max_per_10min: 4 });
    // webhookUrl weggelaten = ongewijzigd
    const r2 = await player.api.servers.updateNotifications({ uuid, autoRestart: false, autoRestartMax: 4 });
    expect(r2.webhook.set).toBe(true);
    expect(h.daemon.servers.get(uuid)!.spec.auto_restart).toBeNull();
    await player.api.servers.testWebhook({ uuid });
    expect(sent.at(-1)!.url).toBe(GOOD2);
    await expect(admin.api.servers.testWebhook({ uuid })).resolves.toBeTruthy(); // volledige admin mag beheren
  });

  it("admin-webhook: alleen admins", async () => {
    await expect(player.api.admin.notifications.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await admin.api.admin.notifications.set({ url: GOOD3 })).set).toBe(true);
    await admin.api.admin.notifications.test();
    expect(sent.at(-1)!.url).toBe(GOOD3);
  });
});

describe("meldingen vanuit de remote-API", () => {
  beforeEach(async () => {
    await player.api.account.setWebhook({ url: GOOD });
    await player.api.servers.updateNotifications({ uuid, webhookUrl: GOOD2, autoRestart: false, autoRestartMax: 3 });
    await admin.api.admin.notifications.set({ url: GOOD3 });
    sent = [];
  });

  it("crash gaat naar server-, eigenaar- en admin-webhook, elk één keer", async () => {
    const r = await event(post(`/api/remote/servers/${uuid}/event`, crashBody), params({ uuid }));
    expect(r.status).toBe(204);
    expect(sent.map((s) => s.url).sort()).toEqual([GOOD, GOOD2, GOOD3].sort());
    expect(sent[0]!.body.embeds[0]!.title).toBe("Server crashed");
    const [log] = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "server.crashed"));
    expect(log!.serverId).toBe(serverId);
  });

  it("dezelfde URL bij server en eigenaar wordt één keer gebruikt", async () => {
    await player.api.account.setWebhook({ url: GOOD2 });
    await event(post(`/api/remote/servers/${uuid}/event`, crashBody), params({ uuid }));
    expect(sent.map((s) => s.url).sort()).toEqual([GOOD2, GOOD3].sort());
  });

  it("herhaalde crashes worden samengevoegd tot één samenvatting", async () => {
    let t = 1_000_000;
    clock.now = () => t;
    const timers: (() => void)[] = [];
    clock.timer = (fn) => (timers.push(fn), 0 as unknown as ReturnType<typeof setTimeout>);
    await event(post(`/api/remote/servers/${uuid}/event`, crashBody), params({ uuid }));
    expect(sent).toHaveLength(3);
    for (let i = 0; i < 4; i++) await event(post(`/api/remote/servers/${uuid}/event`, { ...crashBody, restart_attempt: 2 + i }), params({ uuid }));
    expect(sent).toHaveLength(3); // niets extra's binnen het venster
    t += 5 * 60_000 + 1;
    timers[0]!();
    await vi.waitFor(() => expect(sent).toHaveLength(6));
    expect(sent).toHaveLength(6);
    const rep = sent.at(-1)!.body.embeds[0]!.fields!.find((f) => f.name === "Repeats");
    expect(rep!.value).toContain("4 more");
    // na het venster gaat een nieuwe crash weer meteen
    await event(post(`/api/remote/servers/${uuid}/event`, crashBody), params({ uuid }));
    expect(sent).toHaveLength(9);
  });

  it("andere server of andere soort wordt niet samengevoegd", async () => {
    await event(post(`/api/remote/servers/${uuid}/event`, crashBody), params({ uuid }));
    await event(post(`/api/remote/servers/${uuid}/event`, { type: "disk_warning", disk_bytes: 950 << 20, disk_limit_bytes: 1024 << 20 }), params({ uuid }));
    expect(sent).toHaveLength(6);
    expect(sent.some((s) => s.body.embeds[0]!.title === "Disk almost full")).toBe(true);
  });

  it("onbekende server, slechte body en ontbrekende token", async () => {
    const other = "11111111-2222-4333-8444-555555555555";
    expect((await event(post(`/api/remote/servers/${other}/event`, crashBody), params({ uuid: other }))).status).toBe(404);
    expect((await event(post(`/api/remote/servers/${uuid}/event`, { type: "boem" }), params({ uuid }))).status).toBe(400);
    const noAuth = new Request("http://panel.test/x", { method: "POST", body: JSON.stringify(crashBody) });
    expect((await event(noAuth, params({ uuid }))).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("een kapotte webhook breekt de remote-aanroep niet", async () => {
    respond = () => ({ status: 404 });
    expect((await event(post(`/api/remote/servers/${uuid}/event`, crashBody), params({ uuid }))).status).toBe(204);
  });

  it("installatie en backup mislukt", async () => {
    await installReport(post(`/api/remote/servers/${uuid}/install`, { successful: false, error: "exit 1" }), params({ uuid }));
    expect(sent.some((s) => s.body.embeds[0]!.title === "Installation failed")).toBe(true);
    sent = [];
    const [b] = await getDb().insert(schema.backups).values({ serverId, name: "nacht", s3Key: "k", status: "running" }).returning();
    await backupReport(post(`/api/remote/backups/${b!.id}`, { successful: false, error: "s3 down" }), params({ backup_id: String(b!.id) }));
    const e = sent.find((s) => s.body.embeds[0]!.title === "Backup failed");
    expect(e!.body.embeds[0]!.fields![0]!.value).toContain("s3 down");
  });
});

describe("monitor", () => {
  beforeEach(async () => {
    await admin.api.admin.notifications.set({ url: GOOD3 });
    sent = [];
  });
  it("node offline pas na twee mislukte controles, één keer, en daarna 'terug'", async () => {
    let down = true;
    const probe = async () => {
      if (down) throw new Error("timeout");
    };
    await checkNodes(probe);
    expect(sent).toHaveLength(0);
    await checkNodes(probe);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(GOOD3);
    expect(sent[0]!.body.embeds[0]!.title).toBe("Node offline");
    await checkNodes(probe);
    expect(sent).toHaveLength(1);
    down = false;
    await checkNodes(probe);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.embeds[0]!.title).toBe("Node back online");
  });
  it("SSL: alleen de overgang naar failed meldt, en de status wordt bijgewerkt", async () => {
    await getDb().update(schema.servers).set({ domainsAllowed: true }).where(eq(schema.servers.id, serverId));
    await getDb().insert(schema.domains).values({ serverId, hostname: "mc.panel.test", protocol: "http", targetPort: 80, sslStatus: "issuing" });
    await player.api.account.setWebhook({ url: null });
    await player.api.servers.updateNotifications({ uuid, webhookUrl: null, autoRestart: false, autoRestartMax: 3 });
    await checkSsl(async () => [{ host: "mc.panel.test", ssl_status: "failed" }]);
    expect(sent.map((s) => s.url)).toEqual([GOOD3]);
    expect(sent[0]!.body.embeds[0]!.title).toBe("SSL certificate failed");
    const [d] = await getDb().select().from(schema.domains).where(eq(schema.domains.hostname, "mc.panel.test"));
    expect(d!.sslStatus).toBe("failed");
    await checkSsl(async () => [{ host: "mc.panel.test", ssl_status: "failed" }]);
    expect(sent).toHaveLength(1);
  });
});
