/**
 * HTTP(S)-relay (panelkant): keuze per node, config voor beide daemons, DNS naar de relay-node, SSL-status van de
 * relay-node, statusmeldingen, rechten en de join van een node zonder 80/443.
 */
import { eq } from "drizzle-orm";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as relayConfig } from "@/app/api/remote/relay/route";
import { POST as relayReport } from "@/app/api/remote/relay/status/route";
import { getDb, schema } from "./db";
import { daemonUrlOverrides } from "./daemon";
import { setCloudflareBase } from "./lib/cloudflare";
import { setDnsLookup, type DnsLookup } from "./lib/dns";
import { exchangeJoinCode } from "./join";
import { checkSsl } from "./monitor";
import { resetNodeIpCache } from "./relay";
import { FakeDaemon } from "./test/fake-daemon";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser;
let nodeB = 0, nodeC = 0, tokenB = "";
let d2: FakeDaemon;
const A_IP = "198.51.100.1";
const B_IP = "203.0.113.20";
const limits = { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 };

// ---- nep-Cloudflare met zone node2.test
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
    if (u.pathname === "/zones") return send(200, { success: true, result: [{ id: "z1", name: "node2.test" }], result_info: { page: 1, total_pages: 1 } });
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
const aRecord = (name: string) => cfRecords.find((r) => r.name === name && r.type === "A")?.content;

const zone: Record<string, string[]> = {};
const fakeDns: DnsLookup = { a: async (n) => zone[n] ?? [], aaaa: async () => [], cname: async () => [], ns: async () => [], srv: async () => [] };

const req = (path: string, token: string, body?: unknown) =>
  new Request(`http://panel.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = { params: Promise.resolve({}) } as never;
const nodeRow = async (id: number) => (await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, id)))[0]!;
const refreshes = (d: FakeDaemon) => d.requests.filter((r) => r.method === "POST" && r.path === "/api/relay/refresh").length;

beforeAll(async () => {
  setDnsLookup(fakeDns);
  zone["node1.test"] = [A_IP];
  await startCloudflare();
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "290000000000000002", name: "speler" });
  await admin.api.admin.dnsProviders.create({ type: "cloudflare", name: "CF", apiToken: "cf-test-token" });
  const b = await admin.api.admin.nodes.create({ name: "node2", fqdn: "node2.test", daemonPort: 8080, sftpPort: 2023, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null });
  nodeB = b.node.id;
  tokenB = b.token;
  d2 = new FakeDaemon(b.token);
  daemonUrlOverrides.set(nodeB, await d2.start());
  await getDb().update(schema.nodes).set({ publicIp: B_IP }).where(eq(schema.nodes.id, nodeB));
  const c = await admin.api.admin.nodes.create({ name: "node3", fqdn: "node3.test", daemonPort: 8080, sftpPort: 2024, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null });
  nodeC = c.node.id;
  daemonUrlOverrides.set(nodeC, "http://127.0.0.1:1");
}, 180_000);
afterAll(async () => {
  setDnsLookup(null);
  setCloudflareBase(null);
  daemonUrlOverrides.clear();
  await d2?.stop();
  cf?.closeAllConnections();
  cf?.close();
});

describe("HTTP(S)-relay", () => {
  it("alleen admins", async () => {
    await expect(player.api.admin.nodes.relayStatus({ id: nodeB })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(player.api.admin.nodes.setHttpRelay({ id: nodeB, relayNodeId: h.localNodeId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("relayStatus zonder relay: kandidaten zijn nodes met eigen 80/443", async () => {
    const st = await admin.api.admin.nodes.relayStatus({ id: nodeB });
    expect(st.relayNodeId).toBeNull();
    expect(st.candidates.map((c) => c.id).sort()).toEqual([h.localNodeId, nodeC].sort());
    expect(st.tunnel).toBeNull();
    expect(st.dns[0]).toMatchObject({ name: "node2.test", managed: true });
    // De lokale node draait het panel: die kan nooit via een relay.
    expect((await admin.api.admin.nodes.relayStatus({ id: h.localNodeId })).candidates).toEqual([]);
  });

  it("weigert ongeldige keuzes", async () => {
    await expect(admin.api.admin.nodes.setHttpRelay({ id: h.localNodeId, relayNodeId: nodeB })).rejects.toMatchObject({ message: expect.stringMatching(/^RELAY_NOT_ALLOWED/) });
    await expect(admin.api.admin.nodes.setHttpRelay({ id: nodeB, relayNodeId: nodeB })).rejects.toMatchObject({ message: expect.stringMatching(/^RELAY_NOT_ALLOWED/) });
    await getDb().update(schema.nodes).set({ supportsDomains: false, publicPort: 8443 }).where(eq(schema.nodes.id, nodeC));
    await expect(admin.api.admin.nodes.setHttpRelay({ id: nodeB, relayNodeId: nodeC })).rejects.toMatchObject({ message: expect.stringMatching(/80\/443/) });
    await getDb().update(schema.nodes).set({ supportsDomains: true, publicPort: 443 }).where(eq(schema.nodes.id, nodeC));
    await expect(admin.api.admin.nodes.setHttpRelay({ id: nodeB, relayNodeId: 999_999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("relay aanzetten: geheim, DNS van het node-domein naar de relay-node, beide daemons gepord", async () => {
    const before = refreshes(h.daemon);
    const r = await admin.api.admin.nodes.setHttpRelay({ id: nodeB, relayNodeId: h.localNodeId });
    expect(r.node.httpRelayNodeId).toBe(h.localNodeId);
    expect(r.node.supportsDomains).toBe(true);
    expect(r.node.publicPort).toBe(443);
    expect(r.dns).toEqual([{ name: "node2.test", type: "A", value: A_IP, managed: true, applied: true, error: null, ok: null }]);
    expect(aRecord("node2.test")).toBe(A_IP);
    const row = await nodeRow(nodeB);
    expect(row.relaySecretEnc).toBeTruthy();
    expect(row.relaySecretEnc).not.toContain(" ");
    await vi.waitFor(() => {
      expect(refreshes(h.daemon)).toBeGreaterThan(before);
      expect(refreshes(d2)).toBeGreaterThan(0);
    });
    // Ketens bestaan niet: node3 kan niet via node2 (die loopt zelf via een relay).
    await expect(admin.api.admin.nodes.setHttpRelay({ id: nodeC, relayNodeId: nodeB })).rejects.toMatchObject({ message: expect.stringMatching(/itself relays/) });
    // Domeinen uitzetten kan niet zolang de relay aan staat.
    await expect(
      admin.api.admin.nodes.update({ id: nodeB, name: "node2", fqdn: "node2.test", daemonPort: 8080, sftpPort: 2023, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null, supportsDomains: false, publicPort: 8443 }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/^RELAY_ACTIVE/) });
  });

  it("remote-config: A krijgt B als client (alleen toegewezen hosts), B krijgt A als edge met hetzelfde geheim", async () => {
    const a = await relayConfig(req("/api/remote/relay", h.env.NODE_TOKEN!), params);
    expect(a.status).toBe(200);
    const ca = (await a.json()) as any;
    expect(ca.edge).toBeNull();
    expect(ca.clients).toHaveLength(1);
    expect(ca.clients[0]).toMatchObject({ node_id: nodeB, fqdn: "node2.test", hosts: [] });
    const b = (await (await relayConfig(req("/api/remote/relay", tokenB), params)).json()) as any;
    expect(b.clients).toEqual([]);
    expect(b.edge).toMatchObject({ node_id: h.localNodeId, url: "https://node1.test", fqdn: "node1.test", client_id: nodeB });
    expect(b.edge.secret).toBe(ca.clients[0].secret);
    expect(b.edge.secret.length).toBeGreaterThanOrEqual(32);
    expect((await relayConfig(req("/api/remote/relay", "fout"), params)).status).toBe(401);
  });

  let siteUuid = "";
  it("domein op B: DNS-doel is A, Minecraft blijft B, de relay krijgt de hostnaam", async () => {
    resetNodeIpCache();
    const s = await admin.api.admin.servers.create({ name: "Site", ownerId: player.id, nodeId: nodeB, templateId: await h.templateId("testweb"), limits, allocationIds: [], variables: {}, startOnInstall: false });
    siteUuid = s.uuid;
    const before = refreshes(h.daemon);
    await player.api.domains.add({ uuid: siteUuid, hostname: "site.node2.test", protocol: "http", targetPort: null, redirectTo: null, wildcard: false, dnsProviderId: null });
    expect(refreshes(h.daemon)).toBeGreaterThan(before); // direct gepord
    // De route staat op B (via de relay bereikt), de hostnaam staat in de config van A.
    expect(d2.routes.has("site.node2.test")).toBe(true);
    const ca = (await (await relayConfig(req("/api/remote/relay", h.env.NODE_TOKEN!), params)).json()) as any;
    expect(ca.clients[0].hosts).toEqual([{ host: "site.node2.test", wildcard: false, dns_challenge: null }]);
    const t = await player.api.domains.target({ uuid: siteUuid });
    expect(t).toEqual({ ip: A_IP, nodeFqdn: "node2.test", gameIp: B_IP, relayFqdn: "node1.test" });
    // De DNS-controle verwacht het IP van A.
    zone["site.node2.test"] = [B_IP];
    const [d] = await player.api.domains.list({ uuid: siteUuid });
    const wrong = await player.api.domains.check({ id: d!.id });
    expect(wrong.records.find((r) => r.type === "A")).toMatchObject({ expected: A_IP });
    zone["site.node2.test"] = [A_IP];
    const right = await player.api.domains.check({ id: d!.id });
    expect(right.records.find((r) => r.type === "A")?.status).toBe("ok");
  });

  it("SSL-status komt van de relay-node (die heeft de certificaten)", async () => {
    d2.routes.get("site.node2.test")!.ssl_status = "issuing";
    h.daemon.relayState = { http_mode: "direct", edge: null, clients: [{ node_id: nodeB, fqdn: "node2.test", connected: true, hosts: ["node2.test", "site.node2.test"], ssl: [{ host: "site.node2.test", ssl_status: "active", ssl_error: null }] }] };
    const [d] = await player.api.domains.list({ uuid: siteUuid });
    expect(d!.sslStatus).toBe("active");
    h.daemon.relayState.clients[0]!.ssl = [{ host: "site.node2.test", ssl_status: "failed", ssl_error: "x" }];
    await checkSsl();
    const [row] = await getDb().select().from(schema.domains).where(eq(schema.domains.hostname, "site.node2.test"));
    expect(row!.sslStatus).toBe("failed");
  });

  it("tunnelstatus: B meldt, A live; meldingen over een andere edge tellen niet", async () => {
    const report = { edge_node_id: h.localNodeId, connected: true, connected_at: new Date().toISOString(), latency_ms: 12.5, last_error: null, last_error_at: null, reconnects: 2, http_mode: "relay" };
    expect((await relayReport(req("/api/remote/relay/status", tokenB, report), params)).status).toBe(204);
    expect((await relayReport(req("/api/remote/relay/status", tokenB, { ...report, edge_node_id: nodeC, connected: false }), params)).status).toBe(204);
    expect((await relayReport(req("/api/remote/relay/status", tokenB, { nope: 1 }), params)).status).toBe(400);
    h.daemon.relayState.clients[0]!.latency_ms = 11;
    const st = await admin.api.admin.nodes.relayStatus({ id: nodeB });
    expect(st.relayNodeId).toBe(h.localNodeId);
    expect(st.httpIp).toBe(A_IP);
    expect(st.tunnel).toMatchObject({ connected: true, latencyMs: 12.5, reconnects: 2, httpMode: "relay" });
    expect(st.edge).toEqual({ connected: true, latencyMs: 11, lastError: null, hosts: ["node2.test", "site.node2.test"] });
    expect(st.dns.map((d) => [d.name, d.value, d.ok])).toEqual([
      ["node2.test", A_IP, false],
      ["site.node2.test", A_IP, true],
    ]);
    const a = await admin.api.admin.nodes.relayStatus({ id: h.localNodeId });
    expect(a.clients).toEqual([{ id: nodeB, name: "node2", fqdn: "node2.test" }]);
  });

  it("de relay-node verwijderen kan niet zolang er clients zijn", async () => {
    // node3 als relay voor een nieuwe node4, dan node3 verwijderen.
    const n4 = await admin.api.admin.nodes.create({ name: "node4", fqdn: "node4.test", daemonPort: 8080, sftpPort: 2025, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null });
    daemonUrlOverrides.set(n4.node.id, "http://127.0.0.1:1");
    await admin.api.admin.nodes.setHttpRelay({ id: n4.node.id, relayNodeId: nodeC });
    await expect(admin.api.admin.nodes.delete({ id: nodeC })).rejects.toMatchObject({ message: expect.stringMatching(/^NODE_IS_RELAY/) });
    await expect(admin.api.admin.nodes.setHttpRelay({ id: nodeC, relayNodeId: h.localNodeId })).rejects.toMatchObject({ message: expect.stringMatching(/^NODE_IS_RELAY/) });
    await admin.api.admin.nodes.setHttpRelay({ id: n4.node.id, relayNodeId: null });
    await admin.api.admin.nodes.delete({ id: n4.node.id });
  });

  it("relay uit: DNS terug naar het eigen IP, configs leeg", async () => {
    resetNodeIpCache();
    const r = await admin.api.admin.nodes.setHttpRelay({ id: nodeB, relayNodeId: null });
    expect(r.node.httpRelayNodeId).toBeNull();
    // node-domein (Cloudflare-zone) en het domein van de site (geen provider gekoppeld: alleen gemeld).
    expect(r.dns.map((d) => [d.name, d.value, d.applied])).toEqual([
      ["node2.test", B_IP, true],
      ["site.node2.test", B_IP, null],
    ]);
    expect(aRecord("node2.test")).toBe(B_IP);
    expect(aRecord("site.node2.test")).toBeUndefined();
    expect((await nodeRow(nodeB)).relaySecretEnc).toBeNull();
    const ca = (await (await relayConfig(req("/api/remote/relay", h.env.NODE_TOKEN!), params)).json()) as any;
    expect(ca.clients).toEqual([]);
    const cb = (await (await relayConfig(req("/api/remote/relay", tokenB), params)).json()) as any;
    expect(cb.edge).toBeNull();
    zone["node2.test"] = [B_IP]; // DNS is bijgewerkt (zie hierboven)
    const t = await player.api.domains.target({ uuid: siteUuid });
    expect(t).toEqual({ ip: B_IP, nodeFqdn: "node2.test" }); // zonder relay: precies als voorheen
  });

  it("join via een relay: http_mode relay en DNS naar de relay-node", async () => {
    const j = await admin.api.admin.nodes.createJoin({ name: "node5", fqdn: "node5.node2.test", supportsDomains: true, daemonPort: 8080, sftpPort: 2026, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null, allocationPorts: "", httpRelayNodeId: h.localNodeId });
    expect(j.node.httpRelayNodeId).toBe(h.localNodeId);
    await expect(
      admin.api.admin.nodes.createJoin({ name: "node6", supportsDomains: false, publicPort: 8443, daemonPort: 8080, sftpPort: 2027, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null, allocationPorts: "", httpRelayNodeId: h.localNodeId }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/^RELAY_NOT_ALLOWED/) });
    const out = await exchangeJoinCode(j.joinCommand.split("-- ")[1]!, "192.0.2.50");
    expect(out).toMatchObject({ http_mode: "relay", dns_ip: A_IP, supports_domains: true, public_port: 443, dns_mode: "cloudflare" });
    expect(aRecord("node5.node2.test")).toBe(A_IP);
    const row = await nodeRow(j.node.id);
    expect(row.publicIp).toBe("192.0.2.50"); // gamepoorten en allocaties: het eigen IP
    daemonUrlOverrides.set(j.node.id, "http://127.0.0.1:1");
    const st = await admin.api.admin.nodes.joinStatus({ id: j.node.id });
    expect(st.dns.record).toEqual({ type: "A", name: "node5.node2.test", value: A_IP });
  });

  it("nodes zonder relay: join meldt http_mode direct met het eigen IP", async () => {
    const j = await admin.api.admin.nodes.createJoin({ name: "node7", fqdn: "node7.test", supportsDomains: true, daemonPort: 8080, sftpPort: 2028, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null, allocationPorts: "" });
    const out = await exchangeJoinCode(j.joinCommand.split("-- ")[1]!, "192.0.2.51");
    expect(out).toMatchObject({ http_mode: "direct", dns_ip: "192.0.2.51" });
  });
});
