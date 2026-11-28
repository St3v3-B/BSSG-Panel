/**
 * mail.*: alle procedures tegen een echte Postgres (harness) en een nep-daemon voor /api/mail/*, met een
 * nep-resolver en een nep-Cloudflare. Ook de leesrol mail_reader op de views.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDb, schema as dbSchema } from "@panel/db";
import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureMailReader } from "../boot";
import { getDb, schema } from "../db";
import { transport } from "../discord-webhook";
import { resetEnv } from "../env";
import { decrypt, encrypt } from "../lib/crypto";
import { setCloudflareBase } from "../lib/cloudflare";
import { setDnsLookup, type DnsLookup } from "../lib/dns";
import { setAdminHook } from "../notify";
import type { RecordedRequest } from "../test/fake-daemon";
import { OWNER, useHarness, type TestUser } from "../test/harness";
import { verifyMailPassword } from "./core";
import { REPORT_KEY } from "./checks";

const READER_PW = "mail-reader-test-pw-0123456789";
const h = useHarness({ env: { MAIL_HOSTNAME: "mail.panel.test", MAIL_DB_PASSWORD: READER_PW, MAIL_PUBLIC_IPV4: "203.0.113.10" } });
let admin: TestUser, player: TestUser;

// ---------- nep-daemon voor /api/mail/* ----------

type Check = { id: string; ok: boolean; required: boolean; detail: string; hint?: string };
const ALL_IDS = ["outbound_25", "inbound_ports", "ptr", "fcrdns", "helo", "blacklists", "certificate", "ports_free", "clock", "disk"];
const fake = {
  enabled: false,
  checks: [] as Check[],
  dkim: new Map<string, { selector: string; pem: string }>(),
  deletedData: [] as string[],
  queue: [] as Array<{ queue_id: string; sender: string; recipients: string[]; size: number; arrival_time: string; reason?: string }>,
  quota: new Map<string, number>(),
  down: false,
  failData: false,
  checkCalls: 0,
};
const greenChecks = (): Check[] => ALL_IDS.map((id) => ({ id, ok: true, required: !["clock", "disk"].includes(id), detail: `${id} ok` }));

function mailOverride(r: RecordedRequest): { status: number; body?: unknown } | undefined {
  const path = r.path.split("?")[0]!;
  if (!path.startsWith("/api/mail/")) return undefined;
  if (fake.down) return { status: 503, body: { error: "unavailable", message: "down" } };
  const b = (r.body ?? {}) as Record<string, unknown>;
  if (r.method === "POST" && path === "/api/mail/checks") {
    fake.checkCalls++;
    if (b.mail_hostname !== "mail.panel.test") return { status: 400, body: { error: "bad_request", message: "hostname" } };
    return { status: 200, body: { checked_at: new Date().toISOString(), checks: fake.checks } };
  }
  if (r.method === "GET" && path === "/api/mail/status")
    return { status: 200, body: { enabled: fake.enabled, containers: [{ name: "panel-postfix", state: fake.enabled ? "running" : "exited", health: "healthy" }, { name: "panel-mail-redis", state: "running" }], queue: { active: 1, deferred: fake.queue.length, hold: 0 }, vmail_bytes: 12345 } };
  if (r.method === "POST" && path === "/api/mail/enable") return (fake.enabled = true), { status: 204 };
  if (r.method === "POST" && path === "/api/mail/disable") return (fake.enabled = false), { status: 204 };
  if (r.method === "POST" && path === "/api/mail/reload") return { status: 204 };
  const dk = /^\/api\/mail\/dkim\/([^/]+)$/.exec(path);
  if (dk && r.method === "PUT") {
    fake.dkim.set(decodeURIComponent(dk[1]!), { selector: String(b.selector), pem: String(b.private_key_pem) });
    return { status: 204 };
  }
  if (dk && r.method === "DELETE") return fake.dkim.delete(decodeURIComponent(dk[1]!)) ? { status: 204 } : { status: 404, body: { error: "not_found", message: "no key" } };
  if (r.method === "GET" && path === "/api/mail/queue") return { status: 200, body: { items: fake.queue } };
  if (r.method === "POST" && path === "/api/mail/queue/flush") return { status: 204 };
  const q = /^\/api\/mail\/queue\/([^/]+)$/.exec(path);
  if (q && r.method === "DELETE") {
    const before = fake.queue.length;
    fake.queue = fake.queue.filter((x) => x.queue_id !== q[1]);
    return before === fake.queue.length ? { status: 404, body: { error: "not_found", message: "no such message" } } : { status: 204 };
  }
  if (r.method === "POST" && path === "/api/mail/mailboxes/quota") {
    const addrs = (b.addresses as string[]) ?? [];
    return { status: 200, body: { items: addrs.filter((a) => fake.quota.has(a)).map((a) => ({ address: a, used_bytes: fake.quota.get(a)!, limit_bytes: 1 })) } };
  }
  const md = /^\/api\/mail\/mailboxes\/([^/]+)\/data$/.exec(path);
  if (md && r.method === "DELETE") {
    if (fake.failData) return { status: 503, body: { error: "unavailable", message: "down" } };
    fake.deletedData.push(decodeURIComponent(md[1]!));
    return { status: 204 };
  }
  return { status: 404, body: { error: "not_found", message: `unknown ${r.method} ${path}` } };
}

// ---------- nep-DNS en nep-Cloudflare ----------

const zone: Record<string, Partial<Record<"a" | "aaaa" | "mx" | "txt" | "ptr", string[]>>> = {};
const fakeDns: DnsLookup = {
  a: async (n) => zone[n]?.a ?? [],
  aaaa: async (n) => zone[n]?.aaaa ?? [],
  cname: async () => [],
  ns: async () => [],
  srv: async () => [],
  mx: async (n) => zone[n]?.mx ?? [],
  txt: async (n) => zone[n]?.txt ?? [],
  ptr: async (n) => zone[n]?.ptr ?? [],
};

const CF_TOKEN = "cf-mail-test-token";
let cfServer: Server;
let nextRec = 1;
const cfRecords: Array<{ id: string; zone: string; type: string; name: string; content: string; priority?: number }> = [];
async function startCloudflare() {
  cfServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const send = (status: number, j: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(j));
    if (req.headers.authorization !== `Bearer ${CF_TOKEN}`) return send(403, { success: false, errors: [{ code: 9109, message: "Invalid access token" }], result: null });
    const u = new URL(req.url!, "http://x");
    const m = /^\/zones\/(\w+)\/dns_records(?:\/(\w+))?$/.exec(u.pathname);
    if (!m) return send(404, { success: false, errors: [{ code: 7003, message: "no route" }], result: null });
    const [, z, rid] = m;
    if (req.method === "GET") return send(200, { success: true, result: cfRecords.filter((r) => r.zone === z && r.name === u.searchParams.get("name") && (!u.searchParams.get("type") || r.type === u.searchParams.get("type"))) });
    if (req.method === "POST") {
      const r = { id: `r${nextRec++}`, zone: z!, ...body };
      cfRecords.push(r);
      return send(200, { success: true, result: r });
    }
    const i = cfRecords.findIndex((r) => r.id === rid);
    if (req.method === "DELETE") cfRecords.splice(i, 1);
    return send(200, { success: true, result: { id: rid } });
  });
  await new Promise<void>((r) => cfServer.listen(0, "127.0.0.1", () => r()));
  setCloudflareBase(`http://127.0.0.1:${(cfServer.address() as AddressInfo).port}`);
}

const discordPosts: unknown[] = [];

beforeAll(async () => {
  h.daemon.override = mailOverride;
  setDnsLookup(fakeDns);
  await startCloudflare();
  transport.fetch = (async (_url: string, init?: RequestInit) => {
    discordPosts.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "280000000000000001", name: "speler" });
});

afterAll(async () => {
  setDnsLookup(null);
  setCloudflareBase(null);
  await new Promise<void>((r) => cfServer?.close(() => r()));
});

beforeEach(() => {
  fake.down = false;
  fake.failData = false;
});

const mailRequests = (method: string, prefix: string) => h.daemon.requests.filter((r) => r.method === method && r.path.startsWith(prefix));
const activity = async (action: string) => getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, action));

describe("rechten", () => {
  it("niet-admins krijgen FORBIDDEN, anoniem UNAUTHORIZED", async () => {
    await expect(player.api.mail.status()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(player.api.mail.domains.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(player.api.mail.domains.create({ domain: "panel.test", postmasterTo: "a@example.com" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(player.api.mail.mailboxes.create({ domainId: 1, localPart: "x", password: "123456789012" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(player.api.mail.aliases.list({ domainId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(player.api.mail.queue.flush()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(player.api.mail.enable()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await h.anon()).mail.checks.last()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("systeemcheck en aan/uit", () => {
  it("checks.last is null; run bewaart het rapport; status toont de stack", async () => {
    expect(await admin.api.mail.checks.last()).toBeNull();
    fake.checks = greenChecks().map((c) => (c.id === "ptr" ? { ...c, ok: false, detail: "PTR wrong", hint: "set PTR" } : c));
    const r = await admin.api.mail.checks.run();
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "ptr")).toMatchObject({ ok: false, hint: "set PTR" });
    expect((await admin.api.mail.checks.last())!.checks).toHaveLength(10);
    const st = await admin.api.mail.status();
    expect(st).toMatchObject({ configured: true, mailHostname: "mail.panel.test", reachable: true, enabled: false, vmailBytes: 12345, lastCheck: { ok: false, failedRequired: ["ptr"] } });
    expect(st.containers[1]).toEqual({ name: "panel-mail-redis", state: "running", health: null });
    expect(await activity("admin.mail.checks.run")).toHaveLength(1);
  });

  it("enable weigert met MAIL_CHECKS_FAILED; een rapport ≤ 1 uur oud wordt hergebruikt", async () => {
    const calls = fake.checkCalls;
    fake.checks = greenChecks();
    await expect(admin.api.mail.enable()).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "MAIL_CHECKS_FAILED" });
    expect(fake.checkCalls).toBe(calls); // niet opnieuw gecontroleerd
    expect(mailRequests("POST", "/api/mail/enable")).toHaveLength(0);
    // Rapport ouder dan een uur: opnieuw controleren (nu groen) en aanzetten.
    const [row] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, REPORT_KEY));
    await getDb().update(schema.settings).set({ value: { ...(row!.value as object), checkedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } }).where(eq(schema.settings.key, REPORT_KEY));
    expect(await admin.api.mail.enable()).toEqual({ ok: true });
    expect(fake.checkCalls).toBe(calls + 1);
    expect(fake.enabled).toBe(true);
    expect(await activity("admin.mail.enable")).toHaveLength(1);
  });

  it("niet-verplichte rode checks blokkeren niet", async () => {
    fake.checks = greenChecks().map((c) => (c.id === "disk" ? { ...c, ok: false } : c));
    await admin.api.mail.checks.run();
    expect(await admin.api.mail.enable()).toEqual({ ok: true });
  });

  it("groen → rood van een verplichte check gaat naar de admin-webhook", async () => {
    await setAdminHook("https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz");
    fake.checks = greenChecks();
    await admin.api.mail.checks.run();
    discordPosts.length = 0;
    fake.checks = greenChecks().map((c) => (c.id === "blacklists" ? { ...c, ok: false, detail: "listed on Spamhaus" } : c));
    await admin.api.mail.checks.run();
    expect(discordPosts).toHaveLength(1);
    expect(JSON.stringify(discordPosts[0])).toContain("blacklists");
    // Blijft rood: geen nieuwe melding.
    await admin.api.mail.checks.run();
    expect(discordPosts).toHaveLength(1);
    await setAdminHook(null);
  });

  it("disable en daemon onbereikbaar", async () => {
    expect(await admin.api.mail.disable()).toEqual({ ok: true });
    expect(fake.enabled).toBe(false);
    fake.down = true;
    expect(await admin.api.mail.status()).toMatchObject({ reachable: false, enabled: false, containers: [], queue: null });
    await expect(admin.api.mail.disable()).rejects.toMatchObject({ message: "DAEMON_UNREACHABLE" });
  });

  it("zonder MAIL_HOSTNAME: MAIL_NOT_CONFIGURED", async () => {
    process.env.MAIL_HOSTNAME = "";
    resetEnv();
    try {
      await expect(admin.api.mail.checks.run()).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "MAIL_NOT_CONFIGURED" });
      await expect(admin.api.mail.enable()).rejects.toMatchObject({ message: "MAIL_NOT_CONFIGURED" });
      expect((await admin.api.mail.status()).configured).toBe(false);
    } finally {
      process.env.MAIL_HOSTNAME = "mail.panel.test";
      resetEnv();
    }
  });
});

let d1 = 0;
let steveId = 0;

describe("domeinen", () => {
  it("create: invoer streng gevalideerd, postmaster-doel verplicht", async () => {
    await expect(admin.api.mail.domains.create({ domain: "Not A Domain" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.api.mail.domains.create({ domain: "*.panel.test", postmasterTo: "a@example.com" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.api.mail.domains.create({ domain: "panel.test" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "MAIL_POSTMASTER_TARGET_REQUIRED" });
    await expect(admin.api.mail.domains.create({ domain: "mail.panel.test", postmasterTo: "a@example.com" })).rejects.toMatchObject({ message: "MAIL_DOMAIN_IS_HOSTNAME" });
    await expect(admin.api.mail.domains.create({ domain: "panel.test", firstMailbox: { localPart: "steve", password: "kort" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("create met eerste mailbox: DKIM naar de daemon, postmaster@ en abuse@ naar de mailbox", async () => {
    const d = await admin.api.mail.domains.create({ domain: "Panel.Test", description: "Hoofd", firstMailbox: { localPart: "Steve", name: "Steve", password: "correct horse battery", quotaMb: 2048 } });
    d1 = d.id;
    expect(d).toMatchObject({ domain: "panel.test", description: "Hoofd", dnsStatus: "pending", mailboxCount: 1, aliasCount: 2, quotaAllocatedMb: 2048, dkim: { selector: "dkim" } });
    const sent = fake.dkim.get("panel.test")!;
    expect(sent.selector).toBe("dkim");
    expect(sent.pem).toContain("BEGIN RSA PRIVATE KEY");
    const [k] = await getDb().select().from(schema.mailDkimKeys).where(eq(schema.mailDkimKeys.domainId, d.id));
    expect(decrypt(k!.privateKeyEnc)).toBe(sent.pem);
    expect(k!.publicKey).toBe(d.dkim!.publicKey);
    const [mb] = await getDb().select().from(schema.mailMailboxes).where(eq(schema.mailMailboxes.domainId, d.id));
    steveId = mb!.id;
    expect(mb!.address).toBe("steve@panel.test");
    expect(await verifyMailPassword(mb!.passwordHash, "correct horse battery")).toBe(true);
    const aliases = await admin.api.mail.aliases.list({ domainId: d.id });
    expect(aliases.map((a) => [a.address, a.goto])).toEqual([["abuse@panel.test", ["steve@panel.test"]], ["postmaster@panel.test", ["steve@panel.test"]]]);
    await expect(admin.api.mail.domains.create({ domain: "panel.test", postmasterTo: "a@example.com" })).rejects.toMatchObject({ code: "CONFLICT", message: "MAIL_DOMAIN_EXISTS" });
    expect(await activity("admin.mail.domain.create")).toHaveLength(1);
  });

  it("create met postmasterTo; een niet-bestaand doel in een eigen domein is ongeldig", async () => {
    await expect(admin.api.mail.domains.create({ domain: "shop.panel.test", postmasterTo: "nobody@panel.test" })).rejects.toMatchObject({ message: "MAIL_INVALID_TARGET" });
    expect(await admin.api.mail.domains.list()).toHaveLength(1);
    const d = await admin.api.mail.domains.create({ domain: "shop.panel.test", postmasterTo: "steve@panel.test", maxMailboxes: 2, maxQuotaMb: 2048 });
    expect(d).toMatchObject({ mailboxCount: 0, aliasCount: 2 });
    const d3 = await admin.api.mail.domains.create({ domain: "node1.test", postmasterTo: "ops@example.com" });
    expect((await admin.api.mail.aliases.list({ domainId: d3.id }))[0]!.goto).toEqual(["ops@example.com"]);
    expect((await admin.api.mail.domains.list()).map((x) => x.domain)).toEqual(["node1.test", "panel.test", "shop.panel.test"]);
    expect(await admin.api.mail.domains.get({ id: d.id })).toMatchObject({ domain: "shop.panel.test", maxMailboxes: 2 });
    await expect(admin.api.mail.domains.get({ id: 99999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("mailboxen en quota", () => {
  let shop = 0;
  beforeAll(async () => {
    shop = (await admin.api.mail.domains.list()).find((d) => d.domain === "shop.panel.test")!.id;
  });

  it("max_quota_mb en max_mailboxes worden afgedwongen", async () => {
    const a = await admin.api.mail.mailboxes.create({ domainId: shop, localPart: "orders", name: "Orders", password: "orders-password-1", quotaMb: 1024 });
    expect(a).toMatchObject({ address: "orders@shop.panel.test", quotaMb: 1024, active: true, usedBytes: null });
    await expect(admin.api.mail.mailboxes.create({ domainId: shop, localPart: "big", password: "big-password-123", quotaMb: 1500 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "MAIL_DOMAIN_QUOTA" });
    await admin.api.mail.mailboxes.create({ domainId: shop, localPart: "jan", password: "jan-password-123", quotaMb: 1024 });
    await expect(admin.api.mail.mailboxes.create({ domainId: shop, localPart: "derde", password: "derde-password-1", quotaMb: 1 })).rejects.toMatchObject({ message: "MAIL_MAILBOX_LIMIT" });
    await expect(admin.api.mail.mailboxes.update({ id: a.id, quotaMb: 1100 })).rejects.toMatchObject({ message: "MAIL_DOMAIN_QUOTA" });
    expect(await admin.api.mail.mailboxes.update({ id: a.id, quotaMb: 512, name: "Bestellingen" })).toMatchObject({ quotaMb: 512, name: "Bestellingen" });
    await expect(admin.api.mail.domains.update({ id: shop, maxQuotaMb: 1000 })).rejects.toMatchObject({ message: "MAIL_DOMAIN_QUOTA" });
    await expect(admin.api.mail.domains.update({ id: shop, maxMailboxes: 1 })).rejects.toMatchObject({ message: "MAIL_MAILBOX_LIMIT" });
    expect(await admin.api.mail.domains.update({ id: shop, maxMailboxes: 0, maxQuotaMb: 0, description: "Winkel" })).toMatchObject({ maxMailboxes: 0, maxQuotaMb: 0, description: "Winkel", quotaAllocatedMb: 1536 });
  });

  it("dubbel adres, ongeldige local part", async () => {
    await expect(admin.api.mail.mailboxes.create({ domainId: shop, localPart: "orders", password: "orders-password-1" })).rejects.toMatchObject({ code: "CONFLICT", message: "MAIL_ADDRESS_EXISTS" });
    await expect(admin.api.mail.mailboxes.create({ domainId: shop, localPart: "postmaster", password: "orders-password-1" })).rejects.toMatchObject({ code: "CONFLICT", message: "MAIL_ADDRESS_EXISTS" });
    for (const lp of ["a b", ".start", "end.", "a..b", "x@y", "ü"]) await expect(admin.api.mail.mailboxes.create({ domainId: shop, localPart: lp, password: "orders-password-1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("list: zoeken en quotaverbruik van de daemon (best effort)", async () => {
    fake.quota.set("orders@shop.panel.test", 4096);
    const all = await admin.api.mail.mailboxes.list({ domainId: shop });
    expect(all.map((m) => [m.localPart, m.usedBytes])).toEqual([["jan", null], ["orders", 4096]]);
    expect((await admin.api.mail.mailboxes.list({ domainId: shop, search: "BESTEL" })).map((m) => m.localPart)).toEqual(["orders"]);
    expect(await admin.api.mail.mailboxes.list({ domainId: shop, search: "%" })).toEqual([]);
    fake.down = true;
    expect((await admin.api.mail.mailboxes.list({ domainId: shop })).every((m) => m.usedBytes === null)).toBe(true);
  });

  it("setPassword en actief/inactief (views volgen)", async () => {
    await expect(admin.api.mail.mailboxes.setPassword({ id: steveId, password: "short" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await admin.api.mail.mailboxes.setPassword({ id: steveId, password: "a whole new password" })).toEqual({ ok: true });
    const [mb] = await getDb().select().from(schema.mailMailboxes).where(eq(schema.mailMailboxes.id, steveId));
    expect(await verifyMailPassword(mb!.passwordHash, "a whole new password")).toBe(true);
    const view = async () => (await getDb().execute(sql`select address from mail.v_mailboxes where address = 'steve@panel.test'`)).length;
    expect(await view()).toBe(1);
    await admin.api.mail.mailboxes.update({ id: steveId, active: false });
    expect(await view()).toBe(0);
    await admin.api.mail.mailboxes.update({ id: steveId, active: true });
    expect(await activity("admin.mail.mailbox.set_password")).toHaveLength(1);
  });

  it("delete: Maildir via de daemon; daemon weg → blijft (inactief) bestaan", async () => {
    const m = (await admin.api.mail.mailboxes.list({ domainId: shop })).find((x) => x.localPart === "jan")!;
    fake.failData = true;
    await expect(admin.api.mail.mailboxes.delete({ id: m.id })).rejects.toMatchObject({ message: "DAEMON_UNREACHABLE" });
    const [still] = await getDb().select().from(schema.mailMailboxes).where(eq(schema.mailMailboxes.id, m.id));
    expect(still!.active).toBe(false);
    fake.failData = false;
    expect(await admin.api.mail.mailboxes.delete({ id: m.id })).toEqual({ ok: true });
    expect(fake.deletedData).toContain("jan@shop.panel.test");
    await expect(admin.api.mail.mailboxes.delete({ id: m.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("aliassen en catch-all", () => {
  it("catch-all = @domein, één per domein", async () => {
    const c = await admin.api.mail.aliases.create({ domainId: d1, localPart: null, goto: ["steve@panel.test"] });
    expect(c).toMatchObject({ address: "@panel.test", catchAll: true, goto: ["steve@panel.test"] });
    await expect(admin.api.mail.aliases.create({ domainId: d1, localPart: null, goto: ["steve@panel.test"] })).rejects.toMatchObject({ code: "CONFLICT" });
    const list = await admin.api.mail.aliases.list({ domainId: d1 });
    expect(list.at(-1)!.catchAll).toBe(true);
  });

  it("doelen valideren", async () => {
    await expect(admin.api.mail.aliases.create({ domainId: d1, localPart: "self", goto: ["self@panel.test"] })).rejects.toMatchObject({ message: "MAIL_INVALID_TARGET" });
    await expect(admin.api.mail.aliases.create({ domainId: d1, localPart: "x", goto: ["missing@panel.test"] })).rejects.toMatchObject({ message: "MAIL_INVALID_TARGET" });
    await expect(admin.api.mail.aliases.create({ domainId: d1, localPart: "x", goto: ["not an address"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.api.mail.aliases.create({ domainId: d1, localPart: "x", goto: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.api.mail.aliases.create({ domainId: d1, localPart: "steve", goto: ["a@example.com"] })).rejects.toMatchObject({ message: "MAIL_ADDRESS_EXISTS" });
    const a = await admin.api.mail.aliases.create({ domainId: d1, localPart: "sales", goto: ["Steve@panel.test", "extern@example.com", "steve@panel.test", "postmaster@panel.test"] });
    expect(a.goto).toEqual(["steve@panel.test", "extern@example.com", "postmaster@panel.test"]);
    const u = await admin.api.mail.aliases.update({ id: a.id, goto: ["extern@example.com"], active: false });
    expect(u).toMatchObject({ goto: ["extern@example.com"], active: false });
    await expect(admin.api.mail.aliases.update({ id: a.id, goto: ["sales@panel.test"] })).rejects.toMatchObject({ message: "MAIL_INVALID_TARGET" });
    await admin.api.mail.aliases.update({ id: a.id, goto: ["steve@panel.test"], active: true });
  });

  it("views: v_aliases en v_senders (catch-all niet als afzender)", async () => {
    const aliases = await getDb().execute(sql`select address, goto from mail.v_aliases where address like '%panel.test' order by address`);
    expect(aliases.map((r) => r.address)).toContain("@panel.test");
    const senders = (await getDb().execute(sql`select sender, login from mail.v_senders where login = 'steve@panel.test' order by sender`)).map((r) => r.sender);
    expect([...senders].sort()).toEqual(["abuse@panel.test", "postmaster@panel.test", "postmaster@shop.panel.test", "abuse@shop.panel.test", "sales@panel.test", "steve@panel.test"].sort());
    expect(senders).not.toContain("@panel.test");
  });

  it("delete", async () => {
    const a = (await admin.api.mail.aliases.list({ domainId: d1 })).find((x) => x.address === "sales@panel.test")!;
    expect(await admin.api.mail.aliases.delete({ id: a.id })).toEqual({ ok: true });
    await expect(admin.api.mail.aliases.delete({ id: a.id })).rejects.toMatchObject({ code: "NOT_FOUND", message: "MAIL_ALIAS_NOT_FOUND" });
  });
});

describe("DNS en DKIM", () => {
  it("dnsRecords zonder controle: alles unchecked; checkDns live", async () => {
    const before = await admin.api.mail.domains.dnsRecords({ id: d1 });
    expect(before.records.every((r) => r.status === "unchecked")).toBe(true);
    expect(before.records.map((r) => r.id)).toEqual(["a", "mx", "spf", "dkim", "dmarc", "ptr"]);
    expect(before.cloudflare).toBeNull();
    const pub = (await admin.api.mail.domains.get({ id: d1 })).dkim!.publicKey;
    zone["mail.panel.test"] = { a: ["203.0.113.10"] };
    zone["panel.test"] = { mx: ["10 mail.panel.test"], txt: ["v=spf1 mx -all"] };
    zone["dkim._domainkey.panel.test"] = { txt: [`v=DKIM1; k=rsa; p=${pub}`] };
    zone["203.0.113.10"] = { ptr: ["static.example.net"] };
    let r = await admin.api.mail.domains.checkDns({ id: d1 });
    expect(Object.fromEntries(r.records.map((x) => [x.id, x.status]))).toEqual({ a: "ok", mx: "ok", spf: "ok", dkim: "ok", dmarc: "missing", ptr: "wrong" });
    expect(r.dnsStatus).toBe("pending");
    zone["_dmarc.panel.test"] = { txt: ["v=DMARC1; p=none; rua=mailto:dmarc@panel.test"] };
    r = await admin.api.mail.domains.checkDns({ id: d1 });
    expect(r.dnsStatus).toBe("ok");
    expect((await admin.api.mail.domains.get({ id: d1 })).dnsStatus).toBe("ok");
    expect((await admin.api.mail.domains.dnsRecords({ id: d1 })).records.find((x) => x.id === "dmarc")!.status).toBe("ok");
  });

  it("rotateDkim: nieuwe selector naar de daemon, oude sleutel inactief, DKIM-record opnieuw te controleren", async () => {
    const r = await admin.api.mail.domains.rotateDkim({ id: d1 });
    const dk = r.records.find((x) => x.id === "dkim")!;
    expect(dk.name).toMatch(/^dkim\d{8}\._domainkey\.panel\.test$/);
    expect(dk.status).toBe("unchecked");
    expect(fake.dkim.get("panel.test")!.selector).toBe(dk.name.split(".")[0]);
    const keys = await getDb().select().from(schema.mailDkimKeys).where(eq(schema.mailDkimKeys.domainId, d1));
    expect(keys.filter((k) => k.active)).toHaveLength(1);
    expect(keys.find((k) => k.selector === "dkim")).toMatchObject({ active: false });
    expect(keys.find((k) => k.selector === "dkim")!.rotatedAt).not.toBeNull();
    await expect(admin.api.mail.domains.rotateDkim({ id: d1, selector: "dkim" })).rejects.toMatchObject({ code: "CONFLICT" });
    // Daemon onbereikbaar: niets veranderd.
    fake.down = true;
    await expect(admin.api.mail.domains.rotateDkim({ id: d1, selector: "nieuw" })).rejects.toMatchObject({ message: "DAEMON_UNREACHABLE" });
    expect(await getDb().select().from(schema.mailDkimKeys).where(eq(schema.mailDkimKeys.domainId, d1))).toHaveLength(2);
  });

  it("applyDns via Cloudflare", async () => {
    await expect(admin.api.mail.domains.applyDns({ id: d1 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "MAIL_NO_DNS_PROVIDER" });
    await getDb().insert(schema.dnsProviders).values({ type: "cloudflare", name: "cf", apiTokenEnc: encrypt(CF_TOKEN), zones: [{ id: "z1", name: "panel.test" }] });
    const node1 = (await admin.api.mail.domains.list()).find((d) => d.domain === "node1.test")!;
    await expect(admin.api.mail.domains.applyDns({ id: node1.id })).rejects.toMatchObject({ message: "MAIL_ZONE_NOT_FOUND" });
    cfRecords.push({ id: "oldmx", zone: "z1", type: "MX", name: "panel.test", content: "mx.old.example", priority: 5 });
    cfRecords.push({ id: "oldspf", zone: "z1", type: "TXT", name: "panel.test", content: "v=spf1 include:old.example ~all" });
    cfRecords.push({ id: "verify", zone: "z1", type: "TXT", name: "panel.test", content: "google-site-verification=abc" });
    const r = await admin.api.mail.domains.applyDns({ id: d1 });
    expect(r.cloudflare).toMatchObject({ zone: "panel.test" });
    const mine = cfRecords.filter((x) => x.zone === "z1").map((x) => [x.type, x.name, x.content, x.priority ?? null]);
    expect(mine).toContainEqual(["MX", "panel.test", "mail.panel.test", 10]);
    expect(mine).toContainEqual(["TXT", "panel.test", "v=spf1 mx -all", null]);
    expect(mine).toContainEqual(["TXT", "panel.test", "google-site-verification=abc", null]);
    expect(mine.some((x) => x[2] === "mx.old.example" || String(x[2]).includes("old.example ~all"))).toBe(false);
    const dk = r.records.find((x) => x.id === "dkim")!;
    expect(mine).toContainEqual(["TXT", dk.name, dk.value, null]);
    expect(mine).toContainEqual(["TXT", "_dmarc.panel.test", "v=DMARC1; p=none; rua=mailto:dmarc@panel.test", null]);
    // Geen A-record voor de mailhost of PTR aangeraakt.
    expect(cfRecords.some((x) => x.type === "A")).toBe(false);
    expect(await activity("admin.mail.domain.apply_dns")).toHaveLength(1);
  });
});

describe("wachtrij", () => {
  it("list, flush, delete", async () => {
    fake.queue = [
      { queue_id: "4F2A31C0B1", sender: "steve@panel.test", recipients: ["a@example.com"], size: 1234, arrival_time: "2026-11-28T10:00:00Z", reason: "connection timed out" },
      { queue_id: "7B9D02E4A6", sender: "steve@panel.test", recipients: ["b@example.com"], size: 99, arrival_time: "2026-11-28T11:00:00Z" },
    ];
    const items = await admin.api.mail.queue.list();
    expect(items[0]).toEqual({ queueId: "4F2A31C0B1", sender: "steve@panel.test", recipients: ["a@example.com"], size: 1234, arrivalTime: new Date("2026-11-28T10:00:00Z"), reason: "connection timed out" });
    expect(items[1]!.reason).toBeNull();
    expect(await admin.api.mail.queue.flush()).toEqual({ ok: true });
    expect(await admin.api.mail.queue.delete({ queueId: "4F2A31C0B1" })).toEqual({ ok: true });
    await expect(admin.api.mail.queue.delete({ queueId: "4F2A31C0B1" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "MAIL_QUEUE_ITEM_NOT_FOUND" });
    await expect(admin.api.mail.queue.delete({ queueId: "../etc" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    fake.down = true;
    await expect(admin.api.mail.queue.list()).rejects.toMatchObject({ message: "DAEMON_UNREACHABLE" });
  });
});

describe("leesrol mail_reader", () => {
  const readerUrl = () => h.env.DATABASE_URL!.replace("postgres:test@", `mail_reader:${encodeURIComponent(READER_PW)}@`);

  it("SELECT op de vier views mag; tabellen en schrijven niet", async () => {
    const db = createDb(readerUrl());
    try {
      expect((await db.execute(sql`select domain from mail.v_domains order by domain`)).map((r) => r.domain)).toEqual(["node1.test", "panel.test", "shop.panel.test"]);
      const [mb] = await db.execute(sql`select address, domain, local_part, password_hash, quota_mb, maildir from mail.v_mailboxes where address = 'steve@panel.test'`);
      expect(mb).toMatchObject({ domain: "panel.test", local_part: "steve", quota_mb: 2048, maildir: "panel.test/steve/" });
      expect(String(mb!.password_hash)).toMatch(/^\{ARGON2ID\}\$argon2id\$/);
      await db.execute(sql`select * from mail.v_aliases`);
      await db.execute(sql`select * from mail.v_senders`);
      for (const q of [
        sql`select * from mail.mailboxes`,
        sql`select * from mail.dkim_keys`,
        sql`select * from public.users`,
        sql`insert into mail.domains (domain) values ('evil.test')`,
        sql`update mail.v_domains set domain = 'evil.test'`,
        sql`delete from mail.v_mailboxes`,
        sql`insert into mail.v_aliases (address, goto) values ('a@evil.test', 'b@evil.test')`,
      ]) await expect(db.execute(q).catch((e: { cause?: Error }) => Promise.reject(e.cause ?? e))).rejects.toThrow(/permission denied|cannot (insert into|update|delete from) view/);
    } finally {
      await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
    }
  });

  it("boot is idempotent en zet een nieuw wachtwoord", async () => {
    expect(await ensureMailReader()).toBe(true);
    process.env.MAIL_DB_PASSWORD = "another-reader-password-42";
    resetEnv();
    try {
      await ensureMailReader();
      const db = createDb(h.env.DATABASE_URL!.replace("postgres:test@", "mail_reader:another-reader-password-42@"));
      try {
        expect((await db.execute(sql`select count(*)::int as n from mail.v_domains`))[0]!.n).toBe(3);
      } finally {
        await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
      }
    } finally {
      process.env.MAIL_DB_PASSWORD = READER_PW;
      resetEnv();
      await ensureMailReader();
    }
  });
});

describe("domein verwijderen", () => {
  it("Maildirs en DKIM bij de daemon weg, rijen cascade", async () => {
    fake.deletedData.length = 0;
    expect(await admin.api.mail.domains.delete({ id: d1 })).toEqual({ ok: true });
    expect(fake.deletedData).toEqual(["steve@panel.test"]);
    expect(fake.dkim.has("panel.test")).toBe(false);
    expect(await getDb().select().from(schema.mailMailboxes).where(eq(schema.mailMailboxes.domainId, d1))).toEqual([]);
    expect(await getDb().select().from(schema.mailAliases).where(and(eq(schema.mailAliases.domainId, d1)))).toEqual([]);
    expect(await getDb().select().from(dbSchema.mailDkimKeys).where(eq(dbSchema.mailDkimKeys.domainId, d1))).toEqual([]);
    await expect(admin.api.mail.domains.delete({ id: d1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getDb().select().from(schema.activityLog).where(like(schema.activityLog.action, "admin.mail.%"))).length).toBeGreaterThan(15);
  });
});
