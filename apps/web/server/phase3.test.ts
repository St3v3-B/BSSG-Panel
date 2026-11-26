import { eq } from "drizzle-orm";
import { createConnection } from "mariadb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { setDnsLookup, type DnsLookup } from "./lib/dns";
import { resetNodeIpCache } from "./routers/domains";
import { startMariadb, type TestContainer } from "./test/docker";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const ROOT_PW = "test-root-pw";
const h = useHarness({ env: { MARIADB_ROOT_PASSWORD: ROOT_PW, NODE_PUBLIC_IP: "203.0.113.10" } });
let maria: TestContainer;
let admin: TestUser, player: TestUser, sub: TestUser;
let uuid = "";

/** Nep-DNS: records per naam. */
const zone: Record<string, Partial<Record<"a" | "aaaa" | "cname" | "ns", string[]>>> = {};
const fakeDns: DnsLookup = {
  a: async (n) => zone[n]?.a ?? [],
  aaaa: async (n) => zone[n]?.aaaa ?? [],
  cname: async (n) => zone[n]?.cname ?? [],
  ns: async (n) => zone[n]?.ns ?? [],
};

beforeAll(async () => {
  setDnsLookup(fakeDns);
  maria = await startMariadb(ROOT_PW);
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "270000000000000001", name: "webber" });
  sub = await h.user({ discordId: "270000000000000002", name: "kijker" });
  const d = await admin.api.admin.servers.create({
    name: "Site",
    ownerId: player.id,
    nodeId: h.localNodeId,
    templateId: await h.templateId("testweb"),
    limits: { cpuPct: 100, ramMb: 256, swapMb: 0, diskMb: 1024 },
    allocationIds: [],
    variables: {},
    startOnInstall: true,
  });
  uuid = d.uuid;
  await player.api.subusers.invite({ uuid, who: sub.discordId, permissions: ["files.read"] });
}, 180_000);

afterAll(async () => {
  setDnsLookup(null);
  await maria?.stop();
});

describe("domains.*", () => {
  let id = 0;

  it("add zet de route via de daemon; dubbel → CONFLICT; game-server → BAD_REQUEST; subuser zonder recht → FORBIDDEN", async () => {
    const d = await player.api.domains.add({ uuid, hostname: "blokgenoten.test", targetPort: null, redirectTo: null, wildcard: false, dnsProviderId: null });
    id = d.id;
    expect(d).toMatchObject({ hostname: "blokgenoten.test", sslStatus: "active", dnsStatus: "unchecked" });
    expect(h.daemon.last("PUT", "/api/routes/")!.body).toEqual({ host: "blokgenoten.test", server_uuid: uuid, port: null, redirect_to: null, wildcard: false, dns_challenge: null });
    await expect(player.api.domains.add({ uuid, hostname: "blokgenoten.test", targetPort: null, redirectTo: null, wildcard: false, dnsProviderId: null })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(player.api.domains.add({ uuid, hostname: "x.test", targetPort: null, redirectTo: null, wildcard: true, dnsProviderId: null })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(sub.api.domains.add({ uuid, hostname: "sub.test", targetPort: null, redirectTo: null, wildcard: false, dnsProviderId: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await sub.api.domains.list({ uuid })).map((x) => x.hostname)).toEqual(["blokgenoten.test"]);
  });

  it("redirect (www → apex) en update", async () => {
    const w = await player.api.domains.add({ uuid, hostname: "www.blokgenoten.test", targetPort: null, redirectTo: "blokgenoten.test", wildcard: false, dnsProviderId: null });
    expect(h.daemon.routes.get("www.blokgenoten.test")).toMatchObject({ redirect_to: "blokgenoten.test" });
    await expect(player.api.domains.update({ id: w.id, targetPort: null, redirectTo: "www.blokgenoten.test" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const u = await player.api.domains.update({ id, targetPort: 3000, redirectTo: null });
    expect(u.targetPort).toBe(3000);
    expect(h.daemon.routes.get("blokgenoten.test")).toMatchObject({ port: 3000 });
    await expect(sub.api.domains.update({ id, targetPort: 1, redirectTo: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ssl-status komt live uit de daemon", async () => {
    h.daemon.routes.get("blokgenoten.test")!.ssl_status = "issuing";
    expect((await player.api.domains.list({ uuid })).find((d) => d.id === id)!.sslStatus).toBe("issuing");
  });

  it("target: NODE_PUBLIC_IP", async () => {
    expect(await player.api.domains.target({ uuid })).toEqual({ ip: "203.0.113.10", nodeFqdn: "node1.test" });
  });

  it("check: ok, verkeerd IP, ontbrekend, Cloudflare-proxy, oude AAAA, CNAME op apex; provider uit NS", async () => {
    expect(await player.api.domains.lastCheck({ id })).toBeNull();
    zone["blokgenoten.test"] = { a: ["203.0.113.10"], ns: ["ns0.transip.net", "ns1.transip.nl"] };
    let c = await player.api.domains.check({ id });
    expect(c).toMatchObject({ provider: "transip", warnings: [], records: [{ type: "A", name: "@", expected: "203.0.113.10", status: "ok" }] });
    expect((await player.api.domains.list({ uuid })).find((d) => d.id === id)!.dnsStatus).toBe("ok");
    expect((await player.api.domains.lastCheck({ id }))!.checkedAt).toBeInstanceOf(Date);

    zone["blokgenoten.test"] = { a: ["198.51.100.1"], aaaa: ["2001:db8::1"], cname: ["elders.example"], ns: ["ada.ns.cloudflare.com"] };
    c = await player.api.domains.check({ id });
    expect(c.provider).toBe("cloudflare");
    expect(c.records.map((r) => [r.type, r.status])).toEqual([["A", "wrong_ip"], ["AAAA", "unexpected"], ["CNAME", "unexpected"]]);
    expect(c.warnings.sort()).toEqual(["cname_at_apex", "stale_aaaa"]);

    zone["blokgenoten.test"] = { a: ["104.21.3.4"], aaaa: ["2606:4700::1"], ns: ["ada.ns.cloudflare.com"] };
    c = await player.api.domains.check({ id });
    expect(c.records[0]!.status).toBe("cloudflare_proxy");
    expect(c.warnings).toEqual(["cloudflare_proxy"]);

    zone["blokgenoten.test"] = { ns: ["ns1.dns-parking.com"] };
    c = await player.api.domains.check({ id });
    expect(c).toMatchObject({ provider: "hostinger", records: [{ status: "missing" }] });
    const [row] = await getDb().select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row!.dnsStatus).toBe("missing");

    // subdomein: naam "www", NS van de apex, CNAME is daar prima
    zone["www.blokgenoten.test"] = { a: ["203.0.113.10"], cname: ["blokgenoten.test"] };
    zone["blokgenoten.test"] = { ns: ["ns1.versio.nl"] };
    const www = (await player.api.domains.list({ uuid })).find((d) => d.hostname === "www.blokgenoten.test")!;
    c = await player.api.domains.check({ id: www.id });
    expect(c).toMatchObject({ provider: "versio", warnings: [] });
    expect(c.records.map((r) => [r.name, r.type, r.status])).toEqual([["www", "A", "ok"], ["www", "CNAME", "ok"]]);
  });

  it("target zonder NODE_PUBLIC_IP: A-record van de node", async () => {
    delete process.env.NODE_PUBLIC_IP;
    (await import("./env")).resetEnv();
    resetNodeIpCache();
    zone["node1.test"] = { a: ["192.0.2.7"] };
    try {
      expect((await player.api.domains.target({ uuid })).ip).toBe("192.0.2.7");
    } finally {
      process.env.NODE_PUBLIC_IP = "203.0.113.10";
      (await import("./env")).resetEnv();
      resetNodeIpCache();
    }
  });

  it("remove haalt de route weg", async () => {
    await expect(sub.api.domains.remove({ id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await player.api.domains.remove({ id });
    expect(h.daemon.routes.has("blokgenoten.test")).toBe(false);
    await expect(player.api.domains.lastCheck({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("databases.* en admin.databaseHosts.*", () => {
  let hostId = 0;

  it("boot registreerde de lokale MariaDB als host `local`; test werkt na het richten op de testcontainer", async () => {
    const [local] = await getDb().select().from(schema.databaseHosts).where(eq(schema.databaseHosts.name, "local"));
    expect(local).toMatchObject({ host: "panel-mariadb", port: 3306, adminUser: "root", nodeId: h.localNodeId });
    expect(local!.adminPasswordEnc).toMatch(/^v1:/);
    hostId = local!.id;
    const u = await admin.api.admin.databaseHosts.update({ id: hostId, host: "127.0.0.1", port: maria.port });
    expect(u).toMatchObject({ name: "local", host: "127.0.0.1", databaseCount: 0 });
    expect(await admin.api.admin.databaseHosts.test({ id: hostId })).toEqual({ ok: true, error: null });
    await expect(player.api.admin.databaseHosts.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("create zonder hostId: eigen gebruiker met alleen rechten op die database", async () => {
    const d = await player.api.databases.create({ uuid, name: "wordpress", hostId: null });
    expect(d).toMatchObject({ hostId, hostName: "local", name: `s${uuid.slice(0, 8)}_wordpress`, port: maria.port });
    expect(d.username).toMatch(/^u[0-9a-f]{8}_[A-Za-z0-9]{7}$/);
    const [row] = await getDb().select().from(schema.databases).where(eq(schema.databases.id, d.id));
    expect(row!.passwordEnc).toMatch(/^v1:/);
    expect(row!.passwordEnc).not.toContain(d.password);

    const c = await createConnection({ host: "127.0.0.1", port: maria.port, user: d.username, password: d.password, database: d.name });
    await c.query("CREATE TABLE t (id int)");
    const dbs = (await c.query("SHOW DATABASES")) as Array<{ Database: string }>;
    expect(dbs.map((x) => x.Database).filter((x) => x !== "information_schema")).toEqual([d.name]);
    await expect(c.query("CREATE DATABASE andere")).rejects.toThrow();
    await c.end();

    await expect(player.api.databases.create({ uuid, name: "wordpress", hostId: null })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(sub.api.databases.list({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await player.api.databases.list({ uuid })).map((x) => x.name)).toEqual([d.name]);
    await expect(admin.api.admin.databaseHosts.delete({ id: hostId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("resetPassword en delete", async () => {
    const [d] = await player.api.databases.list({ uuid });
    const r = await player.api.databases.resetPassword({ id: d!.id });
    expect(r.password).not.toBe(d!.password);
    await expect(createConnection({ host: "127.0.0.1", port: maria.port, user: d!.username, password: d!.password })).rejects.toThrow();
    const c = await createConnection({ host: "127.0.0.1", port: maria.port, user: r.username, password: r.password });
    await c.end();
    await expect(sub.api.databases.delete({ id: d!.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await player.api.databases.delete({ id: d!.id });
    expect(await player.api.databases.list({ uuid })).toEqual([]);
    const rc = await createConnection({ host: "127.0.0.1", port: maria.port, user: "root", password: ROOT_PW });
    expect(((await rc.query("SELECT COUNT(*) AS n FROM mysql.user WHERE user = ?", [d!.username])) as Array<{ n: bigint }>)[0]!.n).toBe(0n);
    await rc.end();
  });

  it("admin: host aanmaken, test met fout wachtwoord, verwijderen; server-delete ruimt databases op", async () => {
    const bad = await admin.api.admin.databaseHosts.create({ name: "kapot", host: "127.0.0.1", port: maria.port, adminUser: "root", adminPassword: "fout", nodeId: null });
    expect(bad.databaseCount).toBe(0);
    expect((await admin.api.admin.databaseHosts.test({ id: bad.id })).ok).toBe(false);
    await admin.api.admin.databaseHosts.delete({ id: bad.id });
    expect((await admin.api.admin.databaseHosts.list()).map((x) => x.name)).toEqual(["local"]);

    const d = await player.api.databases.create({ uuid, name: "blijft_niet", hostId });
    await admin.api.admin.servers.delete({ uuid });
    const rc = await createConnection({ host: "127.0.0.1", port: maria.port, user: "root", password: ROOT_PW });
    const dbs = (await rc.query("SHOW DATABASES")) as Array<{ Database: string }>;
    expect(dbs.map((x) => x.Database)).not.toContain(d.name);
    await rc.end();
    expect(h.daemon.routes.has("www.blokgenoten.test")).toBe(false);
  });
});
