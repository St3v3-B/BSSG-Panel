/** phpMyAdmin-SSO: eenmalig token, grantberekening, exchange en (op een echte MariaDB) de uiteindelijke rechten. */
import { eq } from "drizzle-orm";
import { createConnection } from "mariadb";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, schema } from "./db";
import { resetEnv } from "./env";
import { encrypt } from "./lib/crypto";
import { issueToken, pmaAccess, pmaExchange, takeToken } from "./pma";
import { startMariadb, type TestContainer } from "./test/docker";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const ROOT_PW = "test-root-pw";
const SECRET = "s".repeat(40);
const h = useHarness({ env: { PMA_SHARED_SECRET: SECRET } });
let maria: TestContainer;
let admin: TestUser, alice: TestUser, bob: TestUser, carol: TestUser, dave: TestUser, unverifiedAdmin: TestUser;
let serverA = 0, serverB = 0, serverC = 0, serverR = 0;

const exchange = (token: unknown, secret: string | null = SECRET) =>
  pmaExchange(new Request("http://panel.test/api/pma/exchange", { method: "POST", headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify({ token }) }));
const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;
const root = () => createConnection({ host: "127.0.0.1", port: maria.port, user: "root", password: ROOT_PW });
const asUser = (user: string, password: string) => createConnection({ host: "127.0.0.1", port: maria.port, user, password });
async function visible(user: string, password: string): Promise<string[]> {
  const c = await asUser(user, password);
  try {
    return ((await c.query("SHOW DATABASES")) as Array<{ Database: string }>).map((r) => r.Database).filter((d) => d !== "information_schema").sort();
  } finally {
    await c.end();
  }
}
/** Volledige flow voor een gebruiker: tRPC-url -> exchange -> {user, password}. */
async function login(u: TestUser) {
  const { url } = await u.api.databases.phpMyAdminUrl();
  const res = await exchange(tokenOf(url));
  expect(res.status).toBe(200);
  return (await res.json()) as { user: string; password: string };
}

beforeAll(async () => {
  maria = await startMariadb(ROOT_PW);
  // De nep-daemon voert de sync echt uit op de testcontainer (zelfde SQL als daemon/internal/dbadmin SyncPmaUser).
  h.daemon.pmaHook = async (user, password, dbs) => {
    const c = await root();
    try {
      await c.query("DROP USER IF EXISTS ?@'%'", [user]);
      await c.query(`CREATE USER ?@'%' IDENTIFIED BY ? WITH MAX_USER_CONNECTIONS 25`, [user, password]);
      for (const d of dbs) await c.query(`GRANT ALL PRIVILEGES ON \`${d.replaceAll("_", "\\_")}\`.* TO ?@'%'`, [user]);
    } finally {
      await c.end();
    }
  };
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  unverifiedAdmin = await h.user({ discordId: "280000000000000009", name: "halfadmin", admin: true, totp: true, verified: false });
  alice = await h.user({ discordId: "280000000000000001", name: "alice" });
  bob = await h.user({ discordId: "280000000000000002", name: "bob" });
  carol = await h.user({ discordId: "280000000000000003", name: "carol" });
  dave = await h.user({ discordId: "280000000000000004", name: "dave" });
  const db = getDb();
  // De lokale host is daemon-beheerd; een tweede node met eigen host staat niet in phpMyAdmin.
  const [local] = await db
    .insert(schema.databaseHosts)
    .values({ name: "local", host: "panel-mariadb", adminUser: "", adminPasswordEnc: encrypt(""), nodeId: h.localNodeId, daemonManaged: true })
    .onConflictDoNothing()
    .returning();
  const [remoteNode] = await db.insert(schema.nodes).values({ name: "remote", fqdn: "node2.test", tokenHash: "x".repeat(64) }).returning();
  const [remoteHost] = await db.insert(schema.databaseHosts).values({ name: "remote", host: "panel-mariadb", adminUser: "", adminPasswordEnc: encrypt(""), nodeId: remoteNode!.id, daemonManaged: true }).returning();
  const tpl = await h.templateId("testweb");
  const mk = async (name: string, ownerId: number, nodeId = h.localNodeId) =>
    (await db.insert(schema.servers).values({ name, ownerId, nodeId, templateId: tpl, type: "web", cpuPct: 100, ramMb: 256, diskMb: 1024 }).returning())[0]!.id;
  serverA = await mk("A", alice.id);
  serverB = await mk("B", bob.id);
  serverC = await mk("C", dave.id);
  serverR = await mk("R", alice.id, remoteNode!.id);
  const rc = await root();
  const addDb = async (serverId: number, name: string, hostId: number) => {
    if (hostId === local!.id) await rc.query(`CREATE DATABASE \`${name}\``);
    await db.insert(schema.databases).values({ serverId, hostId, name, username: `u_${name}`.slice(0, 32), passwordEnc: encrypt("x") });
  };
  await addDb(serverA, "sa_site", local!.id);
  await addDb(serverA, "sa_blog", local!.id);
  await addDb(serverB, "sb_shop", local!.id);
  await addDb(serverC, "sc_private", local!.id);
  await addDb(serverR, "sr_remote", remoteHost!.id);
  await rc.query("CREATE DATABASE saxsite"); // valt niet onder de underscore van sa_site
  await rc.end();
  // bob: subuser op A met databaserecht; carol: subuser op A zonder.
  await db.insert(schema.subusers).values([
    { serverId: serverA, userId: bob.id, permissions: ["database.manage", "files.read"] },
    { serverId: serverA, userId: carol.id, permissions: ["files.read", "files.write"] },
  ]);
}, 240_000);

afterAll(async () => {
  await maria?.stop();
});

afterEach(() => vi.restoreAllMocks());

describe("grantberekening (pmaAccess)", () => {
  it("eigenaar: eigen databases; remote-node-databases tellen apart", async () => {
    expect(await pmaAccess(alice.id, false)).toEqual({ local: ["sa_blog", "sa_site"], remote: 1 });
  });
  it("subuser met database.manage krijgt de databases van die server, plus zijn eigen", async () => {
    expect(await pmaAccess(bob.id, false)).toEqual({ local: ["sa_blog", "sa_site", "sb_shop"], remote: 0 });
  });
  it("subuser zonder databaserecht en vreemde: niets", async () => {
    expect(await pmaAccess(carol.id, false)).toEqual({ local: [], remote: 0 });
    expect((await pmaAccess(dave.id, false)).local).toEqual(["sc_private"]);
    expect(await pmaAccess(999999, false)).toEqual({ local: [], remote: 0 });
  });
  it("volledige admin: alle klantdatabases op de lokale node", async () => {
    expect(await pmaAccess(admin.id, true)).toEqual({ local: ["sa_blog", "sa_site", "sb_shop", "sc_private"], remote: 1 });
  });
  it("opgeschorte server: niet voor eigenaar, wel voor admin", async () => {
    await getDb().update(schema.servers).set({ suspendedAt: new Date() }).where(eq(schema.servers.id, serverC));
    expect((await pmaAccess(dave.id, false)).local).toEqual([]);
    expect((await pmaAccess(admin.id, true)).local).toContain("sc_private");
    await getDb().update(schema.servers).set({ suspendedAt: null }).where(eq(schema.servers.id, serverC));
  });
});

describe("tRPC databases.phpMyAdminInfo / phpMyAdminUrl", () => {
  it("info: zichtbaar met databases of als volledige admin", async () => {
    expect(await alice.api.databases.phpMyAdminInfo()).toEqual({ visible: true, hasRemoteDatabases: true });
    expect(await bob.api.databases.phpMyAdminInfo()).toEqual({ visible: true, hasRemoteDatabases: false });
    expect(await carol.api.databases.phpMyAdminInfo()).toEqual({ visible: false, hasRemoteDatabases: false });
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
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:3999\/phpmyadmin\/signon\.php\?token=[A-Za-z0-9_-]{40,}$/);
  });
  it("zonder PMA_SHARED_SECRET staat de koppeling uit", async () => {
    const saved = process.env.PMA_SHARED_SECRET;
    delete process.env.PMA_SHARED_SECRET;
    resetEnv();
    try {
      expect(await alice.api.databases.phpMyAdminInfo()).toEqual({ visible: false, hasRemoteDatabases: false });
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
    const ok = await login(dave);
    expect(Object.keys(ok).sort()).toEqual(["password", "user"]);
  });
  it("exchange: gebruiker die intussen alle databases kwijt is krijgt 403", async () => {
    const t = await issueToken({ userId: carol.id, admin: false });
    expect((await exchange(t)).status).toBe(403);
  });
  it("exchange: daemon onbereikbaar geeft 503", async () => {
    const t = await issueToken({ userId: alice.id, admin: false });
    h.daemon.mode = "error500";
    try {
      expect((await exchange(t)).status).toBeGreaterThanOrEqual(502);
    } finally {
      h.daemon.mode = "ok";
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
