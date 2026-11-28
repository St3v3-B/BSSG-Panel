/** phpMyAdmin-SSO: eenmalig token, grantberekening, exchange en (op een echte MariaDB) de uiteindelijke rechten. */
import { eq } from "drizzle-orm";
import { connect as tcpConnect } from "node:net";
import { createConnection } from "mariadb";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, schema } from "./db";
import { resetEnv } from "./env";
import { encrypt } from "./lib/crypto";
import { daemonUrlOverrides } from "./daemon";
import { issueToken, pmaAccess, takeToken } from "./pma";
import { pmaExchange } from "./pma-route";
import { clientAllowed, closeTunnels, resetTunnelAllowCache } from "./pma-tunnel";
import { FakeDaemon } from "./test/fake-daemon";
import { startMariadb, type TestContainer } from "./test/docker";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const ROOT_PW = "test-root-pw";
const SECRET = "s".repeat(40);
const h = useHarness({ env: { PMA_SHARED_SECRET: SECRET, PMA_TUNNEL_PORT_BASE: "0", PMA_TUNNEL_BIND: "127.0.0.1" } });
let maria: TestContainer;
/** Tweede node met eigen MariaDB (eigen container) en een nep-daemon met tunnel. */
let maria2: TestContainer;
let d2: FakeDaemon;
let remoteNodeId = 0, localHostId = 0, remoteHostId = 0;
let admin: TestUser, alice: TestUser, bob: TestUser, carol: TestUser, dave: TestUser, unverifiedAdmin: TestUser;
let serverA = 0, serverB = 0, serverC = 0, serverR = 0;

const exchange = (token: unknown, secret: string | null = SECRET, db?: string) =>
  pmaExchange(new Request("http://panel.test/api/pma/exchange", { method: "POST", headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify({ token, db }) }));
const tokenOf = (url: string) => new URL(url, "http://panel.test").searchParams.get("token")!;
const root = (port = maria.port) => createConnection({ host: "127.0.0.1", port, user: "root", password: ROOT_PW });
const asUser = (user: string, password: string, port = maria.port) => createConnection({ host: "127.0.0.1", port, user, password, connectTimeout: 5000 });
async function visible(user: string, password: string, port = maria.port): Promise<string[]> {
  const c = await asUser(user, password, port);
  try {
    return ((await c.query("SHOW DATABASES")) as Array<{ Database: string }>).map((r) => r.Database).filter((d) => d !== "information_schema").sort();
  } finally {
    await c.end();
  }
}
interface Server { id: number; name: string; local: boolean; port: number; password: string }
interface Answer { user: string; password: string; servers: Server[]; select: number; unavailable: string[] }
/** Volledige flow voor een gebruiker: tRPC-url -> exchange -> {user, password, servers}. */
async function loginFull(u: TestUser, db?: string): Promise<Answer> {
  const { url } = await u.api.databases.phpMyAdminUrl();
  const res = await exchange(tokenOf(url), SECRET, db);
  expect(res.status).toBe(200);
  return (await res.json()) as Answer;
}
/** Alleen de lokale server (zoals vroeger). */
async function login(u: TestUser) {
  const a = await loginFull(u);
  const l = a.servers.find((x) => x.local)!;
  return { user: a.user, password: l.password };
}
/** SQL-sync zoals daemon/internal/dbadmin SyncPmaUser, op een testcontainer. */
const syncOn = (port: () => number) => async (user: string, password: string, dbs: string[]) => {
  const c = await root(port());
  try {
    await c.query("DROP USER IF EXISTS ?@'%'", [user]);
    await c.query(`CREATE USER ?@'%' IDENTIFIED BY ? WITH MAX_USER_CONNECTIONS 25`, [user, password]);
    for (const d of dbs) await c.query(`GRANT ALL PRIVILEGES ON \`${d.replaceAll("_", "\\_")}\`.* TO ?@'%'`, [user]);
  } finally {
    await c.end();
  }
};

beforeAll(async () => {
  [maria, maria2] = await Promise.all([startMariadb(ROOT_PW), startMariadb(ROOT_PW)]);
  // De nep-daemons voeren de sync echt uit op hun testcontainer (zelfde SQL als daemon/internal/dbadmin SyncPmaUser).
  h.daemon.pmaHook = syncOn(() => maria.port);
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  unverifiedAdmin = await h.user({ discordId: "280000000000000009", name: "halfadmin", admin: true, totp: true, verified: false });
  alice = await h.user({ discordId: "280000000000000001", name: "alice" });
  bob = await h.user({ discordId: "280000000000000002", name: "bob" });
  carol = await h.user({ discordId: "280000000000000003", name: "carol" });
  dave = await h.user({ discordId: "280000000000000004", name: "dave" });
  const db = getDb();
  // De lokale host is daemon-beheerd; de tweede node ook (eigen MariaDB, via de tunnel in phpMyAdmin).
  const [local] = await db
    .insert(schema.databaseHosts)
    .values({ name: "local", host: "panel-mariadb", adminUser: "", adminPasswordEnc: encrypt(""), nodeId: h.localNodeId, daemonManaged: true })
    .onConflictDoNothing()
    .returning();
  const n2 = await admin.api.admin.nodes.create({ name: "node2", fqdn: "node2.test", daemonPort: 8080, sftpPort: 2023, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null });
  remoteNodeId = n2.node.id;
  d2 = new FakeDaemon(n2.token);
  daemonUrlOverrides.set(remoteNodeId, await d2.start());
  d2.pmaHook = syncOn(() => maria2.port);
  d2.tunnelTarget = { host: "127.0.0.1", port: maria2.port };
  const remoteNode = n2.node;
  const [remoteHost] = await db.insert(schema.databaseHosts).values({ name: "node2", host: "panel-mariadb", adminUser: "", adminPasswordEnc: encrypt(""), nodeId: remoteNode.id, daemonManaged: true }).returning();
  // Een externe host (niet door een daemon beheerd) komt nooit in phpMyAdmin.
  const [extHost] = await db.insert(schema.databaseHosts).values({ name: "extern", host: "db.example.test", adminUser: "root", adminPasswordEnc: encrypt("x") }).returning();
  localHostId = local!.id;
  remoteHostId = remoteHost!.id;
  const tpl = await h.templateId("testweb");
  const mk = async (name: string, ownerId: number, nodeId = h.localNodeId) =>
    (await db.insert(schema.servers).values({ name, ownerId, nodeId, templateId: tpl, type: "web", cpuPct: 100, ramMb: 256, diskMb: 1024 }).returning())[0]!.id;
  let serverX = 0, serverE = 0;
  serverA = await mk("A", alice.id);
  serverB = await mk("B", bob.id);
  serverC = await mk("C", dave.id);
  serverR = await mk("R", alice.id, remoteNode.id);
  serverX = await mk("X", bob.id, remoteNode.id);
  serverE = await mk("E", alice.id);
  const rc = await root();
  const rc2 = await root(maria2.port);
  const addDb = async (serverId: number, name: string, hostId: number) => {
    if (hostId === local!.id) await rc.query(`CREATE DATABASE \`${name}\``);
    if (hostId === remoteHost!.id) await rc2.query(`CREATE DATABASE \`${name}\``);
    await db.insert(schema.databases).values({ serverId, hostId, name, username: `u_${name}`.slice(0, 32), passwordEnc: encrypt("x") });
  };
  await addDb(serverA, "sa_site", local!.id);
  await addDb(serverA, "sa_blog", local!.id);
  await addDb(serverB, "sb_shop", local!.id);
  await addDb(serverC, "sc_private", local!.id);
  await addDb(serverR, "sr_remote", remoteHost!.id);
  await addDb(serverX, "sx_bobremote", remoteHost!.id);
  await addDb(serverE, "se_extern", extHost!.id);
  await rc.query("CREATE DATABASE saxsite"); // valt niet onder de underscore van sa_site
  await rc2.query("CREATE DATABASE sa_site"); // zelfde naam als lokaal, maar op node 2 en niet van alice
  await rc.end();
  await rc2.end();
  // bob: subuser op A met databaserecht; carol: subuser op A zonder.
  await db.insert(schema.subusers).values([
    { serverId: serverA, userId: bob.id, permissions: ["database.manage", "files.read"] },
    { serverId: serverA, userId: carol.id, permissions: ["files.read", "files.write"] },
  ]);
}, 240_000);

afterAll(async () => {
  daemonUrlOverrides.clear();
  await closeTunnels();
  await d2?.stop();
  await Promise.all([maria?.stop(), maria2?.stop()]);
});

afterEach(() => vi.restoreAllMocks());

/** Compacte weergave: [node, databases] per node, plus het aantal externe databases. */
const summary = async (userId: number, admin: boolean) => {
  const a = await pmaAccess(userId, admin);
  return { nodes: a.nodes.map((n) => [n.isLocal ? "local" : n.name, n.databases] as const), external: a.external };
};

describe("grantberekening (pmaAccess)", () => {
  it("eigenaar: eigen databases per node; externe hosts tellen apart", async () => {
    expect(await summary(alice.id, false)).toEqual({ nodes: [["local", ["sa_blog", "sa_site"]], ["node2", ["sr_remote"]]], external: 1 });
    const a = await pmaAccess(alice.id, false);
    expect(a.nodes.map((n) => n.hostIds)).toEqual([[localHostId], [remoteHostId]]);
  });
  it("subuser met database.manage krijgt de databases van die server, plus zijn eigen (ook op een andere node)", async () => {
    expect(await summary(bob.id, false)).toEqual({ nodes: [["local", ["sa_blog", "sa_site", "sb_shop"]], ["node2", ["sx_bobremote"]]], external: 0 });
  });
  it("subuser zonder databaserecht en vreemde: niets", async () => {
    expect(await summary(carol.id, false)).toEqual({ nodes: [], external: 0 });
    expect(await summary(dave.id, false)).toEqual({ nodes: [["local", ["sc_private"]]], external: 0 });
    expect(await summary(999999, false)).toEqual({ nodes: [], external: 0 });
  });
  it("volledige admin: alle klantdatabases op alle nodes", async () => {
    expect(await summary(admin.id, true)).toEqual({ nodes: [["local", ["sa_blog", "sa_site", "sb_shop", "sc_private"]], ["node2", ["sr_remote", "sx_bobremote"]]], external: 1 });
  });
  it("opgeschorte server: niet voor eigenaar, wel voor admin", async () => {
    await getDb().update(schema.servers).set({ suspendedAt: new Date() }).where(eq(schema.servers.id, serverC));
    expect((await summary(dave.id, false)).nodes).toEqual([]);
    expect((await pmaAccess(admin.id, true)).nodes[0]!.databases).toContain("sc_private");
    await getDb().update(schema.servers).set({ suspendedAt: null }).where(eq(schema.servers.id, serverC));
  });
});

describe("tRPC databases.phpMyAdminInfo / phpMyAdminUrl", () => {
  it("info: zichtbaar met databases of als volledige admin", async () => {
    // Remote nodes staan erin; alleen de externe host van alice valt erbuiten.
    expect(await alice.api.databases.phpMyAdminInfo()).toEqual({ visible: true, hasRemoteDatabases: true, hostIds: [localHostId, remoteHostId] });
    expect(await bob.api.databases.phpMyAdminInfo()).toEqual({ visible: true, hasRemoteDatabases: false, hostIds: [localHostId, remoteHostId] });
    expect(await carol.api.databases.phpMyAdminInfo()).toEqual({ visible: false, hasRemoteDatabases: false, hostIds: [] });
    expect(await dave.api.databases.phpMyAdminInfo()).toEqual({ visible: true, hasRemoteDatabases: false, hostIds: [localHostId] });
    expect((await admin.api.databases.phpMyAdminInfo()).visible).toBe(true);
    await expect(unverifiedAdmin.api.databases.phpMyAdminInfo()).rejects.toMatchObject({ code: "FORBIDDEN", message: "TOTP_PENDING" });
  });
  it("url: FORBIDDEN NO_DATABASES zonder databases (ook voor een admin zonder geverifieerde TOTP)", async () => {
    await expect(carol.api.databases.phpMyAdminUrl()).rejects.toMatchObject({ code: "FORBIDDEN", message: "NO_DATABASES" });
    await expect(unverifiedAdmin.api.databases.phpMyAdminUrl()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await h.anon()).databases.phpMyAdminUrl()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("url: wijst naar /phpmyadmin/signon.php met een token", async () => {
    const { url } = await alice.api.databases.phpMyAdminUrl();
    expect(url).toMatch(/^\/phpmyadmin\/signon\.php\?token=[A-Za-z0-9_-]{40,}$/); // zelfde origin als het panel (PANEL_URL kan intern zijn)
  });
  it("zonder PMA_SHARED_SECRET staat de koppeling uit", async () => {
    const saved = process.env.PMA_SHARED_SECRET;
    delete process.env.PMA_SHARED_SECRET;
    resetEnv();
    try {
      expect(await alice.api.databases.phpMyAdminInfo()).toEqual({ visible: false, hasRemoteDatabases: false, hostIds: [] });
      await expect(alice.api.databases.phpMyAdminUrl()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect((await exchange("x".repeat(43))).status).toBe(404);
    } finally {
      process.env.PMA_SHARED_SECRET = saved;
      resetEnv();
    }
  });
});

describe("token en exchange", () => {
  it("token is eenmalig", async () => {
    const t = await issueToken({ userId: alice.id, admin: false });
    expect(await takeToken(t)).toEqual({ userId: alice.id, admin: false });
    expect(await takeToken(t)).toBeNull();
    expect(await takeToken("onzin")).toBeNull();
  });
  it("token verloopt na 60 seconden", async () => {
    const t = await issueToken({ userId: alice.id, admin: false });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    expect(await takeToken(t)).toBeNull();
  });
  it("exchange: hergebruik, onbekend token en ontbrekend/verkeerd geheim geven 401", async () => {
    const { url } = await alice.api.databases.phpMyAdminUrl();
    const t = tokenOf(url);
    expect((await exchange(t, null)).status).toBe(401);
    expect((await exchange(t, "fout" + SECRET)).status).toBe(401);
    expect((await exchange(t, SECRET.slice(0, -1) + "x")).status).toBe(401);
    // Een mislukte poging met het verkeerde geheim verbruikt het token niet.
    const ok = await exchange(t);
    expect(ok.status).toBe(200);
    expect((await exchange(t)).status).toBe(401);
    expect((await exchange("a".repeat(43))).status).toBe(401);
    expect((await exchange(undefined)).status).toBe(401);
    expect((await exchange({ x: 1 })).status).toBe(401);
  });
  it("exchange: verlopen token geeft 401", async () => {
    const { url } = await alice.api.databases.phpMyAdminUrl();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    expect((await exchange(tokenOf(url))).status).toBe(401);
  });
  it("exchange: geblokkeerde gebruiker geeft 401, en het antwoord bevat geen databasenamen of host", async () => {
    const t = await issueToken({ userId: dave.id, admin: false });
    await getDb().update(schema.users).set({ blocked: true }).where(eq(schema.users.id, dave.id));
    expect((await exchange(t)).status).toBe(401);
    await getDb().update(schema.users).set({ blocked: false }).where(eq(schema.users.id, dave.id));
    const ok = await loginFull(dave);
    expect(Object.keys(ok).sort()).toEqual(["password", "select", "servers", "unavailable", "user"]);
    expect(ok.servers.map((x) => Object.keys(x).sort())).toEqual([["id", "local", "name", "password", "port"]]);
    expect(JSON.stringify(ok)).not.toMatch(/sc_private|panel-mariadb|node2\.test/);
  });
  it("exchange: gebruiker die intussen alle databases kwijt is krijgt 403", async () => {
    const t = await issueToken({ userId: carol.id, admin: false });
    expect((await exchange(t)).status).toBe(403);
  });
  it("exchange: alle daemons onbereikbaar geeft 502/503", async () => {
    const t = await issueToken({ userId: alice.id, admin: false });
    h.daemon.mode = "error500";
    d2.mode = "error500";
    try {
      expect((await exchange(t)).status).toBeGreaterThanOrEqual(502);
    } finally {
      h.daemon.mode = "ok";
      d2.mode = "ok";
    }
  });
});

describe("rechten op een echte MariaDB", () => {
  it("eigenaar ziet en bewerkt precies zijn databases, niet die van een ander", async () => {
    const a = await login(alice);
    expect(a.user).toBe(`pma_u${alice.id}`);
    expect(await visible(a.user, a.password)).toEqual(["sa_blog", "sa_site"]);
    const c = await asUser(a.user, a.password);
    await c.query("CREATE TABLE sa_site.t (id INT PRIMARY KEY)");
    await c.query("INSERT INTO sa_site.t VALUES (1)");
    await expect(c.query("SELECT 1 FROM sb_shop.x")).rejects.toThrow(/denied/i);
    await expect(c.query("SELECT 1 FROM sc_private.x")).rejects.toThrow(/denied/i);
    await expect(c.query("SELECT 1 FROM saxsite.x")).rejects.toThrow(/denied/i); // underscore is geen jokerteken
    await expect(c.query("SELECT 1 FROM mysql.user")).rejects.toThrow(/denied/i);
    await expect(c.query("CREATE DATABASE nieuw")).rejects.toThrow(/denied/i);
    await expect(c.query("GRANT SELECT ON sa_site.* TO 'x'@'%'")).rejects.toThrow(/denied/i);
    await c.end();
  });

  it("nieuwe login = nieuw wachtwoord; het oude werkt niet meer", async () => {
    const first = await login(alice);
    const second = await login(alice);
    expect(second.password).not.toBe(first.password);
    await expect(asUser(first.user, first.password)).rejects.toThrow();
    expect(await visible(second.user, second.password)).toEqual(["sa_blog", "sa_site"]);
  });

  it("subuser met databaserecht ziet ook de databases van die server; intrekken haalt de grant weg bij de volgende exchange", async () => {
    const b1 = await login(bob);
    expect(await visible(b1.user, b1.password)).toEqual(["sa_blog", "sa_site", "sb_shop"]);
    await getDb().update(schema.subusers).set({ permissions: ["files.read"] }).where(eq(schema.subusers.userId, bob.id));
    const b2 = await login(bob);
    expect(await visible(b2.user, b2.password)).toEqual(["sb_shop"]);
    // En weer terug.
    await getDb().update(schema.subusers).set({ permissions: ["database.manage"] }).where(eq(schema.subusers.userId, bob.id));
    const b3 = await login(bob);
    expect(await visible(b3.user, b3.password)).toEqual(["sa_blog", "sa_site", "sb_shop"]);
  });

  it("subuser zonder databaserecht kan niet inloggen en heeft geen account", async () => {
    await expect(carol.api.databases.phpMyAdminUrl()).rejects.toMatchObject({ message: "NO_DATABASES" });
    const rc = await root();
    expect(((await rc.query("SELECT COUNT(*) AS n FROM mysql.user WHERE user = ?", [`pma_u${carol.id}`])) as Array<{ n: bigint }>)[0]!.n).toBe(0n);
    await rc.end();
  });

  it("volledige admin ziet alle klantdatabases, nooit systeemschema's met schrijfrecht", async () => {
    const a = await login(admin);
    expect(await visible(a.user, a.password)).toEqual(["sa_blog", "sa_site", "sb_shop", "sc_private"]);
    const c = await asUser(a.user, a.password);
    await expect(c.query("SELECT 1 FROM mysql.user")).rejects.toThrow(/denied/i);
    await expect(c.query("DROP TABLE mysql.user")).rejects.toThrow(/denied/i);
    await c.end();
    const rc = await root();
    const grants = (await rc.query(`SHOW GRANTS FOR 'pma_u${admin.id}'@'%'`)) as Array<Record<string, string>>;
    await rc.end();
    const lines = grants.map((g) => Object.values(g)[0]!);
    expect(lines.join("\n")).not.toMatch(/GRANT OPTION/);
    // Globaal alleen USAGE; verder uitsluitend klantdatabases.
    for (const l of lines) expect(l).toMatch(/^GRANT USAGE ON \*\.\* |^GRANT ALL PRIVILEGES ON `(sa|sb|sc)\\_[a-z]+`\.\* /);
  });

  it("een databaseverlies voor de eigenaar: verwijderde server haalt de grant weg bij de volgende exchange", async () => {
    await getDb().delete(schema.databases).where(eq(schema.databases.name, "sa_blog"));
    const a = await login(alice);
    expect(await visible(a.user, a.password)).toEqual(["sa_site"]);
  });
});

describe("gelijktijdige exchanges", () => {
  it("lopen per gebruiker na elkaar; alleen het laatste wachtwoord werkt", async () => {
    const tokens = await Promise.all([1, 2, 3, 4].map(async () => tokenOf((await alice.api.databases.phpMyAdminUrl()).url)));
    const res = await Promise.all(tokens.map((t) => exchange(t)));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const creds = (await Promise.all(res.map((r) => r.json()))) as Array<{ user: string; password: string }>;
    const working: string[] = [];
    for (const c of creds) {
      try {
        await visible(c.user, c.password);
        working.push(c.password);
      } catch {}
    }
    // Precies één account-wachtwoord is nog geldig (het laatst gesyncte); er is dus nooit een half kapot account.
    expect(working).toHaveLength(1);
    expect(h.daemon.pmaUsers.get(`pma_u${alice.id}`)!.password).toBe(working[0]);
  });
});

describe("meerdere nodes (tunnel via de daemon van de node)", () => {
  /** Rauwe TCP-verbinding met een tunnelpoort: wat komt er binnen voordat hij sluit? */
  const rawProbe = (port: number) =>
    new Promise<{ bytes: number; closed: boolean }>((resolve) => {
      let bytes = 0;
      const c = tcpConnect(port, "127.0.0.1");
      const t = setTimeout(() => (c.destroy(), resolve({ bytes, closed: false })), 5000);
      c.on("data", (d) => (bytes += d.length));
      c.on("error", () => {});
      c.on("close", () => (clearTimeout(t), resolve({ bytes, closed: true })));
    });

  it("exchange geeft per node een server; lokaal blijft server 1 op 3306", async () => {
    const a = await loginFull(alice);
    expect(a.user).toBe(`pma_u${alice.id}`);
    expect(a.unavailable).toEqual([]);
    expect(a.servers.map((x) => [x.id, x.local, x.local ? "local" : x.name])).toEqual([[1, true, "local"], [remoteNodeId + 1, false, "node2"]]);
    expect(a.servers[0]!.port).toBe(3306);
    expect(a.servers[1]!.port).toBeGreaterThan(0);
    expect(a.servers[0]!.password).not.toBe(a.servers[1]!.password);
    expect(a.password).toBe(a.servers[0]!.password); // compatibel met een oudere signon.php
    expect(a.select).toBe(1);
    // Grants per node: precies de databases van alice op die node.
    expect(h.daemon.pmaUsers.get(a.user)!.databases).toEqual(["sa_site"]);
    expect(d2.pmaUsers.get(a.user)!.databases).toEqual(["sr_remote"]);
  });

  it("via de tunnel van het panel: de MariaDB van node 2, met alleen de eigen databases", async () => {
    const a = await loginFull(alice);
    const remote = a.servers.find((x) => !x.local)!;
    const before = d2.tunnelsOpened;
    expect(await visible(a.user, remote.password, remote.port)).toEqual(["sr_remote"]); // niet sa_site van node 2
    expect(d2.tunnelsOpened).toBeGreaterThan(before);
    const c = await asUser(a.user, remote.password, remote.port);
    await c.query("CREATE TABLE sr_remote.t (id INT PRIMARY KEY)");
    await c.query("INSERT INTO sr_remote.t VALUES (1), (2)");
    expect(((await c.query("SELECT COUNT(*) AS n FROM sr_remote.t")) as Array<{ n: bigint }>)[0]!.n).toBe(2n);
    await expect(c.query("SELECT 1 FROM sa_site.x")).rejects.toThrow(/denied/i);
    await expect(c.query("SELECT 1 FROM mysql.user")).rejects.toThrow(/denied/i);
    await c.end();
    // Wachtwoorden zijn per node: het lokale werkt niet op node 2.
    await expect(asUser(a.user, a.servers[0]!.password, remote.port)).rejects.toThrow();
  });

  it("deep-link ?db= kiest de server waar die database staat", async () => {
    expect((await loginFull(alice, "sr_remote")).select).toBe(remoteNodeId + 1);
    expect((await loginFull(alice, "sa_site")).select).toBe(1);
    expect((await loginFull(alice, "bestaat_niet")).select).toBe(1);
    expect((await loginFull(alice, "x'; drop")).select).toBe(1);
  });

  it("gebruiker met alleen databases op node 2: geen lokaal account, server 2 is de standaard", async () => {
    const erin = await h.user({ discordId: "280000000000000005", name: "erin" });
    const tpl = await h.templateId("testweb");
    const [srv] = await getDb().insert(schema.servers).values({ name: "Erin", ownerId: erin.id, nodeId: remoteNodeId, templateId: tpl, type: "web", cpuPct: 100, ramMb: 256, diskMb: 1024 }).returning();
    const rc2 = await root(maria2.port);
    await rc2.query("CREATE DATABASE se_erin");
    await rc2.end();
    await getDb().insert(schema.databases).values({ serverId: srv!.id, hostId: remoteHostId, name: "se_erin", username: "u_se_erin", passwordEnc: encrypt("x") });
    expect(await erin.api.databases.phpMyAdminInfo()).toEqual({ visible: true, hasRemoteDatabases: false, hostIds: [remoteHostId] });
    const a = await loginFull(erin);
    expect(a.servers.map((x) => x.id)).toEqual([remoteNodeId + 1]);
    expect(a.select).toBe(remoteNodeId + 1);
    expect(h.daemon.pmaUsers.has(`pma_u${erin.id}`)).toBe(false);
    expect(await visible(a.user, a.servers[0]!.password, a.servers[0]!.port)).toEqual(["se_erin"]);
  });

  it("volledige admin: alle nodes, met alle databases", async () => {
    const a = await loginFull(admin);
    expect(a.servers.map((x) => x.id)).toEqual([1, remoteNodeId + 1]);
    expect(d2.pmaUsers.get(a.user)!.databases).toEqual(expect.arrayContaining(["sr_remote", "sx_bobremote"]));
  });

  it("node 2 geeft een fout: inloggen lukt met alleen de lokale server", async () => {
    d2.mode = "error500";
    try {
      const a = await loginFull(alice);
      expect(a.servers.map((x) => x.id)).toEqual([1]);
      expect(a.unavailable).toEqual(["node2"]);
      expect(await visible(a.user, a.servers[0]!.password)).toEqual(["sa_site"]);
    } finally {
      d2.mode = "ok";
    }
  });

  it("node 2 offline: inloggen lukt lokaal; de tunnel sluit netjes zonder data", async () => {
    const port = (await loginFull(alice)).servers.find((x) => !x.local)!.port;
    await d2.stop();
    try {
      const a = await loginFull(alice);
      expect(a.servers.map((x) => x.local)).toEqual([true]);
      expect(a.unavailable).toEqual(["node2"]);
      expect(await rawProbe(port)).toEqual({ bytes: 0, closed: true });
    } finally {
      daemonUrlOverrides.set(remoteNodeId, await d2.start());
    }
    // Weer online: werkt meteen weer (de node wordt per verbinding opnieuw opgezocht).
    const a = await loginFull(alice);
    const remote = a.servers.find((x) => !x.local)!;
    expect(remote.port).toBe(port);
    expect(await visible(a.user, remote.password, remote.port)).toEqual(["sr_remote"]);
  });

  it("daemon zonder MariaDB of onbekende tunnel: verbinding gaat direct dicht", async () => {
    const port = (await loginFull(alice)).servers.find((x) => !x.local)!.port;
    d2.tunnelTarget = null;
    try {
      expect(await rawProbe(port)).toEqual({ bytes: 0, closed: true });
    } finally {
      d2.tunnelTarget = { host: "127.0.0.1", port: maria2.port };
    }
    // Een ander proces op de MariaDB-poort van de "node" bereiken kan niet: het doel bepaalt de daemon.
    const tunnels = d2.requests.filter((r) => r.path.startsWith("/api/db/tunnel"));
    expect(tunnels.length).toBeGreaterThan(0);
    expect(tunnels.every((r) => r.path === "/api/db/tunnel" && r.auth === `Bearer ${d2.token}`)).toBe(true);
  });

  it("tunnelpoort: alleen loopback en PMA_TUNNEL_ALLOW mogen verbinden", async () => {
    expect(await clientAllowed("127.0.0.1")).toBe(true);
    expect(await clientAllowed("::ffff:127.0.0.1")).toBe(true);
    expect(await clientAllowed("10.9.8.7")).toBe(false);
    expect(await clientAllowed(undefined)).toBe(false);
    process.env.PMA_TUNNEL_ALLOW = "10.9.8.7, localhost";
    resetEnv();
    resetTunnelAllowCache();
    try {
      expect(await clientAllowed("10.9.8.7")).toBe(true);
      expect(await clientAllowed("::ffff:10.9.8.7")).toBe(true);
      expect(await clientAllowed("10.9.8.8")).toBe(false);
    } finally {
      delete process.env.PMA_TUNNEL_ALLOW;
      resetEnv();
      resetTunnelAllowCache();
    }
  });
});
