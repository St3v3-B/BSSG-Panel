import { eq } from "drizzle-orm";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { setCloudflareBase } from "./lib/cloudflare";
import { setDnsLookup, type DnsLookup } from "./lib/dns";
import { resetNodeIpCache } from "./routers/domains";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness({ env: { NODE_PUBLIC_IP: "203.0.113.10" } });
let admin: TestUser, player: TestUser, sub: TestUser;
let uuid = "", webUuid = "";
const limits = { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 };
const add = (o: Record<string, unknown>) => ({ uuid, hostname: "x.test", protocol: "http" as const, targetPort: null, redirectTo: null, wildcard: false, dnsProviderId: null, ...o });

const zone: Record<string, { a?: string[]; srv?: string[] }> = {};
const fakeDns: DnsLookup = {
  a: async (n) => zone[n]?.a ?? [],
  aaaa: async () => [],
  cname: async () => [],
  ns: async () => [],
  srv: async (n) => zone[n]?.srv ?? [],
};

const CF_TOKEN = "cf-test-token";
let cfServer: Server;
let nextRec = 1;
const cfRecords: Array<Record<string, any>> = [];
async function startCloudflare() {
  cfServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const send = (status: number, j: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(j));
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/zones") return send(200, { success: true, result: [{ id: "z1", name: "mc.test" }], result_info: { page: 1, total_pages: 1 } });
    const m = /^\/zones\/(\w+)\/dns_records(?:\/(\w+))?$/.exec(u.pathname);
    if (!m) return send(404, { success: false, errors: [{ code: 1, message: "no route" }], result: null });
    const [, z, rid] = m;
    if (req.method === "GET") return send(200, { success: true, result: cfRecords.filter((r) => r.zone === z && r.name === u.searchParams.get("name")) });
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
  await new Promise<void>((r) => cfServer.listen(0, "127.0.0.1", () => r()));
  setCloudflareBase(`http://127.0.0.1:${(cfServer.address() as AddressInfo).port}`);
}

beforeAll(async () => {
  setDnsLookup(fakeDns);
  await startCloudflare();
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "290000000000000001", name: "speler" });
  sub = await h.user({ discordId: "290000000000000002", name: "kijker" });
  const a = await h.allocation(34100);
  const d = await admin.api.admin.servers.create({ name: "Game", ownerId: player.id, nodeId: h.localNodeId, templateId: await h.templateId("testgame"), limits, allocationIds: [a], variables: {}, startOnInstall: false });
  uuid = d.uuid;
  const w = await admin.api.admin.servers.create({ name: "Web", ownerId: player.id, nodeId: h.localNodeId, templateId: await h.templateId("testweb"), limits, allocationIds: [], variables: {}, startOnInstall: false });
  webUuid = w.uuid;
  await player.api.subusers.invite({ uuid, who: sub.discordId, permissions: ["domain.manage"] });
}, 180_000);

afterAll(async () => {
  setDnsLookup(null);
  setCloudflareBase(null);
  cfServer?.close();
});

describe("domeinen op game-servers", () => {
  it("standaard niet toegestaan; web is altijd toegestaan", async () => {
    expect((await player.api.servers.get({ uuid })).domainsAllowed).toBe(false);
    expect((await player.api.servers.get({ uuid: webUuid })).domainsAllowed).toBe(true);
    await expect(player.api.domains.add(add({ hostname: "map.mc.test", targetPort: 8123 }))).rejects.toMatchObject({ code: "FORBIDDEN", message: "DOMAINS_NOT_ALLOWED" });
    await expect(player.api.admin.servers.setDomainsAllowed({ uuid, allowed: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.api.admin.servers.setDomainsAllowed({ uuid: webUuid, allowed: false })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("web: protocol minecraft is niet toegestaan", async () => {
    await expect(player.api.domains.add(add({ uuid: webUuid, hostname: "w.mc.test", protocol: "minecraft" }))).rejects.toMatchObject({ code: "BAD_REQUEST", message: "PROTOCOL_NOT_ALLOWED" });
  });

  let httpId = 0, mcId = 0;
  it("toestaan; http vereist poort en maakt een route met die poort", async () => {
    await admin.api.admin.servers.setDomainsAllowed({ uuid, allowed: true });
    expect((await player.api.servers.get({ uuid })).domainsAllowed).toBe(true);
    await expect(player.api.domains.add(add({ hostname: "map.mc.test" }))).rejects.toMatchObject({ code: "BAD_REQUEST", message: "PORT_REQUIRED" });
    const d = await player.api.domains.add(add({ hostname: "map.mc.test", targetPort: 8123 }));
    httpId = d.id;
    expect(d).toMatchObject({ protocol: "http", targetPort: 8123 });
    expect(h.daemon.routes.get("map.mc.test")).toMatchObject({ server_uuid: uuid, port: 8123 });
    // subuser met domain.manage mag ook
    expect((await sub.api.domains.list({ uuid })).map((x) => x.hostname)).toEqual(["map.mc.test"]);
    await expect(player.api.domains.update({ id: httpId, targetPort: null, redirectTo: null })).rejects.toMatchObject({ message: "PORT_REQUIRED" });
    await player.api.domains.update({ id: httpId, targetPort: 8100, redirectTo: null });
    expect(h.daemon.routes.get("map.mc.test")).toMatchObject({ port: 8100 });
  });

  it("minecraft: geen route; A + SRV in de check; applyDns zet beide", async () => {
    const before = h.daemon.routes.size;
    await expect(player.api.domains.add(add({ hostname: "play.mc.test", protocol: "minecraft", targetPort: 25565 }))).rejects.toMatchObject({ message: "MINECRAFT_DOMAIN_OPTIONS" });
    const d = await player.api.domains.add(add({ hostname: "play.mc.test", protocol: "minecraft" }));
    mcId = d.id;
    expect(d.protocol).toBe("minecraft");
    expect(h.daemon.routes.size).toBe(before);
    await expect(player.api.domains.add(add({ hostname: "play2.mc.test", protocol: "minecraft" }))).rejects.toMatchObject({ code: "CONFLICT", message: "MINECRAFT_DOMAIN_EXISTS" });

    let c = await player.api.domains.check({ id: mcId });
    expect(c.records.map((r) => [r.type, r.status])).toEqual([["A", "missing"], ["SRV", "missing"]]);
    expect(c.records[1]).toMatchObject({ name: "_minecraft._tcp.play", expected: "0 5 34100 play.mc.test" });

    zone["play.mc.test"] = { a: ["203.0.113.10"] };
    zone["_minecraft._tcp.play.mc.test"] = { srv: ["0 5 34100 play.mc.test"] };
    c = await player.api.domains.check({ id: mcId });
    expect(c.records.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect((await player.api.domains.list({ uuid })).find((x) => x.id === mcId)!.dnsStatus).toBe("ok");
    zone["_minecraft._tcp.play.mc.test"] = { srv: ["0 5 25565 play.mc.test"] };
    c = await player.api.domains.check({ id: mcId });
    expect(c.records[1]!.status).toBe("wrong_ip");
    expect((await player.api.domains.list({ uuid })).find((x) => x.id === mcId)!.dnsStatus).toBe("wrong_ip");

    const p = await admin.api.admin.dnsProviders.create({ type: "cloudflare", name: "CF", apiToken: CF_TOKEN });
    await getDb().update(schema.domains).set({ dnsProviderId: p.id }).where(eq(schema.domains.id, mcId));
    await player.api.domains.applyDns({ id: mcId });
    await player.api.domains.applyDns({ id: mcId });
    expect(cfRecords.map((r) => [r.type, r.name])).toEqual([["A", "play.mc.test"], ["SRV", "_minecraft._tcp.play.mc.test"]]);
    expect(cfRecords[0]).toMatchObject({ content: "203.0.113.10", proxied: false });
    expect(cfRecords[1]!.data).toEqual({ priority: 0, weight: 5, port: 34100, target: "play.mc.test" });
  });

  it("uitzetten verwijdert domeinen en routes; logt activiteit", async () => {
    await admin.api.admin.servers.setDomainsAllowed({ uuid, allowed: false });
    expect(await player.api.domains.list({ uuid })).toEqual([]);
    expect(h.daemon.routes.has("map.mc.test")).toBe(false);
    expect((await player.api.servers.get({ uuid })).domainsAllowed).toBe(false);
    const acts = await getDb().select().from(schema.activityLog);
    expect(acts.map((x) => x.action)).toEqual(expect.arrayContaining(["admin.server.domains_allow", "admin.server.domains_disallow"]));
    resetNodeIpCache();
  });
});
