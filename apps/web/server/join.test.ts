import { and, eq } from "drizzle-orm";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { daemonUrlOverrides } from "./daemon";
import { setCloudflareBase } from "./lib/cloudflare";
import { decrypt, sha256 } from "./lib/crypto";
import { setDnsLookup, type DnsLookup } from "./lib/dns";
import { acmeDnsHandler, getJoinDaemon, getJoinScript, joinExchange, joinProgress } from "./join-routes";
import { exchangeJoinCode } from "./join";
import { FakeDaemon } from "./test/fake-daemon";
import { OWNER, useHarness, type TestUser } from "./test/harness";
import { transferPollMs } from "./routers/transfer";

const h = useHarness();
let admin: TestUser, player: TestUser;
const limits = { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 };
const base = { daemonPort: 8080, sftpPort: 2022, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null, allocationPorts: "25565-25570" };
const codeOf = (cmd: string) => cmd.split("-- ")[1]!;

// ---- nep-Cloudflare (zone mc.test)
let cf: Server;
let nextRec = 1;
const cfRecords: Array<Record<string, any>> = [];
async function startCloudflare() {
  cf = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const send = (status: number, j: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(j));
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/zones") return send(200, { success: true, result: [{ id: "z1", name: "mc.test" }], result_info: { page: 1, total_pages: 1 } });
    const m = /^\/zones\/(\w+)\/dns_records(?:\/(\w+))?$/.exec(u.pathname);
    if (!m) return send(404, { success: false, errors: [{ code: 1, message: "no route" }], result: null });
    const [, z, rid] = m;
    if (req.method === "GET") return send(200, { success: true, result: cfRecords.filter((r) => r.zone === z && r.name === u.searchParams.get("name") && (!u.searchParams.get("type") || r.type === u.searchParams.get("type"))) });
    if (req.method === "POST") {
      const r = { id: `r${nextRec++}`, zone: z, ...body };
      cfRecords.push(r);
      return send(200, { success: true, result: r });
    }
    const i = cfRecords.findIndex((r) => r.id === rid);
    if (req.method === "PUT") Object.assign(cfRecords[i]!, body);
    if (req.method === "DELETE") cfRecords.splice(i, 1);
    return send(200, { success: true, result: { id: rid } });
  });
  await new Promise<void>((r) => cf.listen(0, "127.0.0.1", () => r()));
  setCloudflareBase(`http://127.0.0.1:${(cf.address() as AddressInfo).port}`);
}

const zone: Record<string, string[]> = {};
const fakeDns: DnsLookup = { a: async (n) => zone[n] ?? [], aaaa: async () => [], cname: async () => [], ns: async () => [], srv: async () => [] };

const post = (path: string, body: unknown, token?: string) =>
  new Request(`http://panel.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const ctx0 = { params: Promise.resolve({}) } as never;

beforeAll(async () => {
  setDnsLookup(fakeDns);
  await startCloudflare();
  transferPollMs.value = 10;
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "290000000000000001", name: "speler" });
  await admin.api.admin.dnsProviders.create({ type: "cloudflare", name: "CF", apiToken: "cf-test-token" });
}, 180_000);
afterAll(async () => {
  setDnsLookup(null);
  setCloudflareBase(null);
  daemonUrlOverrides.clear();
  cf?.closeAllConnections();
  cf?.close();
});

describe("join-code", () => {
  it("createJoin: één regel met code; geen token in het commando; alleen de hash staat in de database", async () => {
    const r = await admin.api.admin.nodes.createJoin({ ...base, name: "node2", supportsDomains: true });
    expect(r.joinCommand).toMatch(/^curl -fsSL http:\/\/127\.0\.0\.1:3999\/join \| sudo bash -s -- [A-Za-z0-9_-]{32}$/);
    expect(r.joinCommand).not.toContain("\n");
    const code = codeOf(r.joinCommand);
    expect(Buffer.from(code, "base64url").length).toBeGreaterThanOrEqual(16); // >= 128 bit
    expect(r.node).toMatchObject({ name: "node2", fqdn: "node2.panel.test", supportsDomains: true, publicPort: 443, joinState: "waiting" });
    const [row] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, r.node.id));
    expect(r.joinCommand).not.toContain(decrypt(row!.tokenEnc!));
    const codes = await getDb().select().from(schema.nodeJoinCodes).where(eq(schema.nodeJoinCodes.nodeId, r.node.id));
    expect(codes).toHaveLength(1);
    expect(codes[0]!.codeHash).toBe(sha256(code));
    expect(JSON.stringify(codes)).not.toContain(code);
    expect(r.expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(r.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    await expect(player.api.admin.nodes.createJoin({ ...base, name: "x", supportsDomains: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("inwisselen: token + config, eenmalig; verlopen en onbekend falen; nieuwe code vervangt de oude", async () => {
    const r = await admin.api.admin.nodes.createJoin({ ...base, name: "node3", supportsDomains: true, fqdn: "n3.other.test" });
    const code = codeOf(r.joinCommand);
    expect(await exchangeJoinCode("onbekend-onbekend-onbekend", "203.0.113.7")).toBeNull();
    const x = await exchangeJoinCode(code, "203.0.113.7");
    expect(x).toMatchObject({ node_domain: "n3.other.test", panel_url: "http://127.0.0.1:3999", daemon_port: 8080, sftp_port: 2022, supports_domains: true, public_port: 443, dns_mode: "manual" });
    const [row] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, r.node.id));
    expect(x!.node_token).toBe(decrypt(row!.tokenEnc!));
    expect(sha256(x!.node_token)).toBe(row!.tokenHash);
    expect(row).toMatchObject({ publicIp: "203.0.113.7", joinState: "docker" });
    expect(await exchangeJoinCode(code, "203.0.113.7")).toBeNull(); // eenmalig

    const r2 = await admin.api.admin.nodes.createJoin({ ...base, name: "node4", supportsDomains: true, fqdn: "n4.other.test" });
    await getDb().update(schema.nodeJoinCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.nodeJoinCodes.nodeId, r2.node.id));
    expect(await exchangeJoinCode(codeOf(r2.joinCommand), "203.0.113.8")).toBeNull(); // verlopen
    const again = await admin.api.admin.nodes.joinCommand({ id: r2.node.id });
    const old = await admin.api.admin.nodes.joinCommand({ id: r2.node.id });
    expect(await exchangeJoinCode(codeOf(again.joinCommand), "203.0.113.8")).toBeNull(); // vervangen
    expect(await exchangeJoinCode(codeOf(old.joinCommand), "203.0.113.8")).not.toBeNull();
  });

  it("HTTP-route: ratelimit-vrije fout voor ongeldige code (404), slechte invoer (400)", async () => {
    expect((await joinExchange(post("/api/join/exchange", { code: "x".repeat(30), ip: "203.0.113.9" }))).status).toBe(404);
    expect((await joinExchange(post("/api/join/exchange", { code: "kort", ip: "203.0.113.9" }))).status).toBe(400);
    expect((await joinExchange(post("/api/join/exchange", { code: "x".repeat(30), ip: "geen-ip" }))).status).toBe(400);
  });
});

describe("Cloudflare en DNS", () => {
  it("zone dekt de naam: A-record onbeproxied naar het gemelde IP; anders handmatig", async () => {
    const r = await admin.api.admin.nodes.createJoin({ ...base, name: "cfnode", supportsDomains: true, fqdn: "cfnode.mc.test" });
    const x = await exchangeJoinCode(codeOf(r.joinCommand), "198.51.100.5");
    expect(x!.dns_mode).toBe("cloudflare");
    expect(cfRecords.filter((c) => c.name === "cfnode.mc.test")).toMatchObject([{ type: "A", content: "198.51.100.5", proxied: false }]);
    const st = await admin.api.admin.nodes.joinStatus({ id: r.node.id });
    expect(st.dns).toMatchObject({ mode: "cloudflare", record: { type: "A", name: "cfnode.mc.test", value: "198.51.100.5" }, ok: false });
    zone["cfnode.mc.test"] = ["198.51.100.5"];
    expect((await admin.api.admin.nodes.joinStatus({ id: r.node.id })).dns.ok).toBe(true);
  });

  it("delete: refuse bij servers, daarna wordt het A-record opgeruimd", async () => {
    const [n] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.fqdn, "cfnode.mc.test"));
    await admin.api.admin.nodes.delete({ id: n!.id });
    expect(cfRecords.filter((c) => c.name === "cfnode.mc.test")).toHaveLength(0);
  });
});

describe("voortgang en afronden", () => {
  it("progress met node-token; ongeldig token/status geweigerd; ready maakt het allocatiebereik aan", async () => {
    const r = await admin.api.admin.nodes.createJoin({ ...base, name: "node5", supportsDomains: true, fqdn: "n5.other.test", allocationPorts: "26000-26004" });
    const x = (await exchangeJoinCode(codeOf(r.joinCommand), "203.0.113.55"))!;
    expect((await joinProgress(post("/api/join/progress", { state: "docker" }), ctx0)).status).toBe(401);
    expect((await joinProgress(post("/api/join/progress", { state: "docker" }, "fout"), ctx0)).status).toBe(401);
    expect((await joinProgress(post("/api/join/progress", { state: "onzin" }, x.node_token), ctx0)).status).toBe(400);
    expect((await joinProgress(post("/api/join/progress", { state: "download", message: "downloading" }, x.node_token), ctx0)).status).toBe(204);
    let st = await admin.api.admin.nodes.joinStatus({ id: r.node.id });
    expect(st).toMatchObject({ state: "download", message: "downloading", daemonConnected: false, certificateOk: false, allocationsCreated: 0, codeUsed: true });

    // De daemon meldt zich (hello) en is bereikbaar over "https" (nep-daemon) -> ready + allocaties.
    const d = new FakeDaemon(x.node_token);
    daemonUrlOverrides.set(r.node.id, await d.start());
    try {
      expect((await joinProgress(post("/api/join/progress", { state: "certificate" }, x.node_token), ctx0)).status).toBe(204);
      await getDb().update(schema.nodes).set({ lastSeenAt: new Date() }).where(eq(schema.nodes.id, r.node.id));
      st = await admin.api.admin.nodes.joinStatus({ id: r.node.id });
      expect(st).toMatchObject({ state: "ready", daemonConnected: true, certificateOk: true, allocationsCreated: 5 });
      const al = await admin.api.admin.allocations.list({ nodeId: r.node.id });
      expect(al.map((a) => [a.ip, a.port])).toEqual([["203.0.113.55", 26000], ["203.0.113.55", 26001], ["203.0.113.55", 26002], ["203.0.113.55", 26003], ["203.0.113.55", 26004]]);
      // Nogmaals: geen dubbele allocaties, en voortgang gaat niet terug.
      await joinProgress(post("/api/join/progress", { state: "docker" }, x.node_token), ctx0);
      st = await admin.api.admin.nodes.joinStatus({ id: r.node.id });
      expect(st.state).toBe("ready");
      expect(await admin.api.admin.allocations.list({ nodeId: r.node.id })).toHaveLength(5);
    } finally {
      await d.stop();
      daemonUrlOverrides.delete(r.node.id);
    }
  });

  it("hello is idempotent: één database-host per node", async () => {
    const r = await admin.api.admin.nodes.createJoin({ ...base, name: "node6", supportsDomains: true, fqdn: "n6.other.test" });
    const [n] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, r.node.id));
    const { registerNodeDatabaseHost } = await import("./node-database");
    await registerNodeDatabaseHost(n!);
    await registerNodeDatabaseHost(n!);
    expect(await getDb().select().from(schema.databaseHosts).where(eq(schema.databaseHosts.nodeId, n!.id))).toHaveLength(1);
  });
});

describe("supports_domains", () => {
  let nodeId = 0, token = "", d2: FakeDaemon;
  let gameTpl = 0, webTpl = 0;
  beforeAll(async () => {
    gameTpl = await h.templateId("testgame");
    webTpl = await h.templateId("testweb");
  });

  it("uit: Cloudflare-zone is vereist; poort 8443 standaard; nodes zonder Caddy melden via de DNS-01-route", async () => {
    await expect(admin.api.admin.nodes.createJoin({ ...base, name: "nocf", supportsDomains: false, fqdn: "nocf.other.test" })).rejects.toMatchObject({ message: expect.stringContaining("NO_DNS_PROVIDER") });
    await expect(admin.api.admin.nodes.createJoin({ ...base, name: "badport", supportsDomains: false, fqdn: "badport.mc.test", publicPort: 2022 })).rejects.toMatchObject({ message: "INVALID_PUBLIC_PORT" });
    const r = await admin.api.admin.nodes.createJoin({ ...base, name: "game2", supportsDomains: false, fqdn: "game2.mc.test" });
    nodeId = r.node.id;
    expect(r.node).toMatchObject({ supportsDomains: false, publicPort: 8443 });
    const x = (await exchangeJoinCode(codeOf(r.joinCommand), "198.51.100.77"))!;
    token = x.node_token;
    expect(x).toMatchObject({ supports_domains: false, public_port: 8443 });
    d2 = new FakeDaemon(token);
    daemonUrlOverrides.set(nodeId, await d2.start());
    d2.override = (q) => (q.path === "/api/update" ? { status: 202 } : undefined);

    const val = "a".repeat(43);
    expect((await acmeDnsHandler(post("/api/remote/acme/dns", { action: "present", value: val }, token), ctx0)).status).toBe(204);
    expect(cfRecords.filter((c) => c.type === "TXT")).toMatchObject([{ name: "_acme-challenge.game2.mc.test", content: val }]);
    expect((await acmeDnsHandler(post("/api/remote/acme/dns", { action: "cleanup", value: val }, token), ctx0)).status).toBe(204);
    expect(cfRecords.filter((c) => c.type === "TXT")).toHaveLength(0);
    expect((await acmeDnsHandler(post("/api/remote/acme/dns", { action: "present", value: "kort" }, token), ctx0)).status).toBe(400);
    expect((await acmeDnsHandler(post("/api/remote/acme/dns", { action: "present", value: val }, "fout"), ctx0)).status).toBe(401);
    // Een node met Caddy (supports_domains) mag dit niet.
    const c = await admin.api.admin.nodes.createJoin({ ...base, name: "caddy", supportsDomains: true, fqdn: "caddy.mc.test" });
    const cx = (await exchangeJoinCode(codeOf(c.joinCommand), "198.51.100.78"))!;
    expect((await acmeDnsHandler(post("/api/remote/acme/dns", { action: "present", value: val }, cx.node_token), ctx0)).status).toBe(403);
  });

  it("geen websites: admin create, quota-create en transfer geweigerd; geen domeinen voor game-servers", async () => {
    await expect(admin.api.admin.servers.create({ name: "W", ownerId: player.id, nodeId, templateId: webTpl, limits, allocationIds: [], variables: {}, startOnInstall: false })).rejects.toMatchObject({ message: expect.stringContaining("NODE_HAS_NO_DOMAINS") });
    await admin.api.admin.users.setQuota({ id: player.id, maxRamMb: 4096, maxDiskMb: 8192, maxCpuPct: 400, maxServers: 5, maxDatabases: 1, templateIds: null, nodeIds: null, maxPortsPerServer: 2 });
    await expect(player.api.servers.create({ name: "W", templateId: webTpl, nodeId, limits: { ramMb: 512, diskMb: 1024, cpuPct: 100 }, ports: 1, variables: {} })).rejects.toMatchObject({ message: expect.stringContaining("NODE_HAS_NO_DOMAINS") });
    const q = await player.api.account.quota();
    expect(q!.nodes.find((n) => n.id === nodeId)).toMatchObject({ supportsDomains: false });

    // Een website op de lokale node mag niet naar de node zonder domeinen.
    const w = await admin.api.admin.servers.create({ name: "W2", ownerId: player.id, nodeId: h.localNodeId, templateId: webTpl, limits, allocationIds: [], variables: {}, startOnInstall: false });
    await expect(admin.api.admin.servers.transfer({ uuid: w.uuid, nodeId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("NODE_HAS_NO_DOMAINS") });

    // Game-server op de node: domeinen niet toe te staan; domains.add geweigerd.
    const [al] = await getDb().insert(schema.allocations).values({ nodeId, ip: "198.51.100.77", port: 27000 }).returning();
    const g = await admin.api.admin.servers.create({ name: "G", ownerId: player.id, nodeId, templateId: gameTpl, limits, allocationIds: [al!.id], variables: {}, startOnInstall: false });
    await expect(admin.api.admin.servers.setDomainsAllowed({ uuid: g.uuid, allowed: true })).rejects.toMatchObject({ message: expect.stringContaining("NODE_HAS_NO_DOMAINS") });
    await getDb().update(schema.servers).set({ domainsAllowed: true }).where(eq(schema.servers.uuid, g.uuid));
    expect((await player.api.servers.get({ uuid: g.uuid })).domainsAllowed).toBe(false); // de UI ziet "niet toegestaan"
    await expect(player.api.domains.add({ uuid: g.uuid, hostname: "x.mc.test", protocol: "http", targetPort: 80, redirectTo: null, wildcard: false, dnsProviderId: null })).rejects.toMatchObject({ message: "NODE_HAS_NO_DOMAINS" });

    // Console- en upload-URL's gebruiken de publieke poort.
    const ct = await player.api.servers.consoleToken({ uuid: g.uuid });
    expect(ct.socketUrl).toBe(`wss://game2.mc.test:8443/api/servers/${g.uuid}/ws`);
    const up = await player.api.files.uploadUrl({ uuid: g.uuid, directory: "/" });
    expect(up.url).toMatch(/^https:\/\/game2\.mc\.test:8443\/api\/servers\//);
    // De panel-naar-node-verbinding gebruikt ook de poort (nep: override) en de daemon-update is bereikbaar.
    await admin.api.admin.nodes.updateDaemon({ id: nodeId });
    expect(d2.requests.some((q) => q.path === "/api/update" && q.auth === `Bearer ${token}`)).toBe(true);
    await expect(admin.api.admin.nodes.updateDaemon({ id: h.localNodeId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.api.admin.nodes.delete({ id: nodeId })).rejects.toMatchObject({ message: "NODE_HAS_SERVERS" });
    await admin.api.admin.servers.delete({ uuid: g.uuid });
  });

  it("aan -> uit alleen zonder websites/domeinen; daarna vlaggen terug; uit -> aan mag", async () => {
    const r = await admin.api.admin.nodes.createJoin({ ...base, name: "flip", supportsDomains: true, fqdn: "flip.mc.test" });
    const id = r.node.id;
    const nodeIn = (supportsDomains: boolean, publicPort: number) => ({ id, name: "flip", fqdn: "flip.mc.test", daemonPort: 8080, sftpPort: 2022, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null, supportsDomains, publicPort });
    const x = (await exchangeJoinCode(codeOf(r.joinCommand), "198.51.100.90"))!;
    const d = new FakeDaemon(x.node_token);
    daemonUrlOverrides.set(id, await d.start());
    try {
      const w = await admin.api.admin.servers.create({ name: "Site", ownerId: player.id, nodeId: id, templateId: webTpl, limits, allocationIds: [], variables: {}, startOnInstall: false });
      await expect(admin.api.admin.nodes.update(nodeIn(false, 8443))).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("NODE_HAS_DOMAINS") });
      await admin.api.admin.servers.delete({ uuid: w.uuid });
      const [al] = await getDb().insert(schema.allocations).values({ nodeId: id, ip: "198.51.100.90", port: 27100 }).returning();
      const g = await admin.api.admin.servers.create({ name: "Spel", ownerId: player.id, nodeId: id, templateId: gameTpl, limits, allocationIds: [al!.id], variables: {}, startOnInstall: false });
      await admin.api.admin.servers.setDomainsAllowed({ uuid: g.uuid, allowed: true });
      const dom = await player.api.domains.add({ uuid: g.uuid, hostname: "kaart.mc.test", protocol: "http", targetPort: 8123, redirectTo: null, wildcard: false, dnsProviderId: null });
      await expect(admin.api.admin.nodes.update(nodeIn(false, 8443))).rejects.toMatchObject({ code: "CONFLICT" });
      await player.api.domains.remove({ id: dom.id });
      const u = await admin.api.admin.nodes.update(nodeIn(false, 8443));
      expect(u).toMatchObject({ supportsDomains: false, publicPort: 8443 });
      const [srv] = await getDb().select().from(schema.servers).where(and(eq(schema.servers.uuid, g.uuid)));
      expect(srv!.domainsAllowed).toBe(false);
      expect(await admin.api.admin.nodes.update(nodeIn(true, 8443))).toMatchObject({ supportsDomains: true, publicPort: 443 });
      await admin.api.admin.servers.delete({ uuid: g.uuid });
    } finally {
      await d.stop();
      daemonUrlOverrides.delete(id);
    }
  });

  afterAll(async () => {
    await d2?.stop();
  });
});

describe("script en binaries", () => {
  it("/join: statisch script met alleen de panel-URL ingevuld; daemon alleen amd64/arm64", async () => {
    const dir = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/join-assets-");
    const fs = await import("node:fs");
    fs.writeFileSync(`${dir}/join.sh`, "#!/bin/bash\nPANEL_URL=__PANEL_URL__\n");
    fs.writeFileSync(`${dir}/panel-daemon-linux-amd64`, "BIN");
    fs.writeFileSync(`${dir}/panel-daemon-linux-amd64.sha256`, "abc\n");
    process.env.JOIN_ASSETS_DIR = dir;
    try {
      const s = await (await getJoinScript()).text();
      expect(s).toBe("#!/bin/bash\nPANEL_URL=http://127.0.0.1:3999\n");
      const p = (arch: string) => getJoinDaemon(new Request("http://x"), { params: Promise.resolve({ arch }) });
      expect(await (await p("amd64")).text()).toBe("BIN");
      expect(await (await p("amd64.sha256")).text()).toBe("abc\n");
      expect((await p("arm64")).status).toBe(404);
      expect((await p("../etc")).status).toBe(404);
    } finally {
      delete process.env.JOIN_ASSETS_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
