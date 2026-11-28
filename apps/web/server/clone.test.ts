import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneTiming } from "./clone";
import { daemonUrlOverrides } from "./daemon";
import { getDb, schema } from "./db";
import { encrypt } from "./lib/crypto";
import { flushNotify, resetNotify } from "./notify";
import { FakeDaemon } from "./test/fake-daemon";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, friend: TestUser, sub: TestUser, stranger: TestUser, nobody: TestUser;
let gameId = 0, webId = 0;
let d2: FakeDaemon;
let node2 = 0;
let port = 33000;
const Q = { maxRamMb: 4096, maxDiskMb: 8192, maxCpuPct: 400, maxServers: 4, maxDatabases: 2, templateIds: null, nodeIds: null, maxPortsPerServer: 2 };
const limits = { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 };

beforeAll(async () => {
  cloneTiming.pollMs = 10;
  cloneTiming.progressMs = 0;
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  friend = await h.user({ discordId: "291000000000000001", name: "vriend" });
  sub = await h.user({ discordId: "291000000000000002", name: "sub" });
  stranger = await h.user({ discordId: "291000000000000003", name: "vreemde" });
  nobody = await h.user({ discordId: "291000000000000004", name: "zonder" });
  gameId = await h.templateId("testgame");
  webId = await h.templateId("testweb");
  await admin.api.admin.users.setQuota({ id: friend.id, ...Q });
  const n = await admin.api.admin.nodes.create({ name: "node2", fqdn: "node2.test", daemonPort: 8080, sftpPort: 2023, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null });
  node2 = n.node.id;
  d2 = new FakeDaemon(n.token);
  daemonUrlOverrides.set(node2, await d2.start());
});
afterAll(async () => {
  await flushNotify();
  daemonUrlOverrides.clear();
  await d2.stop();
});
beforeEach(async () => {
  // Alle servers weg (quotumtellingen per test), fake daemons leeg.
  const db = getDb();
  await db.update(schema.allocations).set({ serverId: null, isPrimary: false });
  await db.delete(schema.servers);
  await db.delete(schema.allocations).where(isNull(schema.allocations.serverId));
  await flushNotify();
  await db.delete(schema.notifications);
  h.daemon.reset();
  d2.reset();
  resetNotify();
});

async function gameServer(owner: TestUser, state: "offline" | "online" = "offline") {
  const s = await admin.api.admin.servers.create({ name: "Bron", ownerId: owner.id, nodeId: h.localNodeId, templateId: gameId, limits, allocationIds: [await h.allocation(port++)], variables: { JAR_FILE: "paper.jar" }, startOnInstall: false });
  h.daemon.servers.get(s.uuid)!.state = state;
  h.daemon.fs(s.uuid).dirs.add("/world");
  h.daemon.fs(s.uuid).files.set("/world/level.dat", "wereld");
  return s.uuid;
}

async function done(u: TestUser, id: number) {
  for (let i = 0; i < 400; i++) {
    const j = await u.api.servers.cloneJob({ id });
    if (j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("clone did not finish");
}
const srvRow = async (uuid: string) => (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid)))[0];
const inbox = async (u: TestUser) => {
  await flushNotify();
  return getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, u.id));
};

describe("servers.clone (zelfde node)", () => {
  it("eigenaar met quotum: zelfde template/variabelen/limieten, nieuwe poort, lokale kopie, melding en log", async () => {
    const src = await gameServer(friend);
    await h.allocation(port++);
    const opts = await friend.api.servers.cloneOptions({ uuid: src });
    expect(opts).toMatchObject({ allowed: true, isAdmin: false, ports: 1, type: "game", quota: { servers: 3 } });
    const job = await friend.api.servers.clone({ uuid: src, name: "Staging" });
    expect(job.status).toBe("running");
    const j = await done(friend, job.id);
    expect(j).toMatchObject({ status: "succeeded", sameNode: true, live: false, target: { name: "Staging", exists: true } });
    expect(j.steps.map((s) => [s.key, s.status])).toEqual([["create", "done"], ["files", "done"], ["databases", "skipped"], ["domain", "skipped"], ["finish", "done"]]);

    const t = (await friend.api.servers.get({ uuid: j.target.uuid }));
    expect(t).toMatchObject({ name: "Staging", templateName: "Testspel", limits: { cpuPct: 100, ramMb: 512, diskMb: 1024, swapMb: 0 } });
    expect(t.variables.find((v) => v.key === "JAR_FILE")!.value).toBe("paper.jar");
    const srcPort = (await friend.api.servers.get({ uuid: src })).allocations[0]!.port;
    expect(t.allocations).toHaveLength(1);
    expect(t.allocations[0]!.port).not.toBe(srcPort);
    // Daemon: aangemaakt zonder installatie, data lokaal gekopieerd (niet via export/import).
    expect(h.daemon.servers.get(j.target.uuid)!.spec.skip_install).toBe(true);
    expect(h.daemon.last("POST", `/api/servers/${j.target.uuid}/transfer/copy`)!.body).toEqual({ source_uuid: src, live: false });
    expect(h.daemon.requests.some((r) => r.path.includes("/transfer/export"))).toBe(false);
    expect(h.daemon.fs(j.target.uuid).files.get("/world/level.dat")).toBe("wereld");
    expect((await srvRow(j.target.uuid))!.status).toBe("offline");

    const log = await admin.api.admin.activity.search({ serverUuid: src });
    expect(log.items.map((i) => i.action)).toContain("server.clone.start");
    const tlog = await admin.api.admin.activity.search({ serverUuid: j.target.uuid });
    expect(tlog.items.map((i) => i.action)).toEqual(expect.arrayContaining(["server.clone.created", "server.clone.complete"]));
    const msgs = await inbox(friend);
    expect(msgs.some((m) => m.event === "server_cloned" && m.title === "Server copy ready")).toBe(true);
    expect(await friend.api.servers.clones({ uuid: src })).toHaveLength(1);
  });

  it("draaiende bron blijft draaien (live); startAfter start de kopie", async () => {
    const src = await gameServer(friend, "online");
    await h.allocation(port++);
    const j = await done(friend, (await friend.api.servers.clone({ uuid: src, name: "Live", startAfter: true })).id);
    expect(j).toMatchObject({ status: "succeeded", live: true });
    expect(h.daemon.last("POST", `/api/servers/${j.target.uuid}/transfer/copy`)!.body).toEqual({ source_uuid: src, live: true });
    expect(h.daemon.servers.get(src)!.state).toBe("online");
    expect(h.daemon.requests.some((r) => r.path === `/api/servers/${src}/power`)).toBe(false);
    expect(h.daemon.last("POST", `/api/servers/${j.target.uuid}/power`)!.body).toEqual({ action: "start" });
  });

  it("oudere daemon zonder /transfer/copy: valt terug op de tar-stroom", async () => {
    const src = await gameServer(friend);
    await h.allocation(port++);
    h.daemon.copyUnsupported = true;
    const j = await done(friend, (await friend.api.servers.clone({ uuid: src, name: "Oud" })).id);
    expect(j.status).toBe("succeeded");
    expect(h.daemon.requests.some((r) => r.path.startsWith(`/api/servers/${src}/transfer/export`))).toBe(true);
    expect(h.daemon.fs(j.target.uuid).files.get("/world/level.dat")).toBe("wereld");
    expect(j.bytesCopied).toBeGreaterThan(0);
  });
});

describe("servers.clone: quotum en rechten", () => {
  it("zonder quotum NO_QUOTA; quotum vol; poorten; limieten; admin-velden; vreemden en subusers", async () => {
    const own = await gameServer(nobody);
    await h.allocation(port++);
    expect((await nobody.api.servers.cloneOptions({ uuid: own })).allowed).toBe(false);
    await expect(nobody.api.servers.clone({ uuid: own, name: "x" })).rejects.toThrow(/NO_QUOTA/);

    const src = await gameServer(friend);
    for (let i = 0; i < 4; i++) await h.allocation(port++);
    await expect(friend.api.servers.clone({ uuid: src, name: "x", limits: { cpuPct: 100, ramMb: 4000, diskMb: 1024 } })).rejects.toThrow(/QUOTA_EXCEEDED: ram/);
    await expect(friend.api.servers.clone({ uuid: src, name: "x", ownerId: stranger.id })).rejects.toThrow(/ADMIN_ONLY/);
    await expect(friend.api.servers.clone({ uuid: src, name: "x", nodeId: node2 })).rejects.toThrow(/ADMIN_ONLY/);
    await expect(stranger.api.servers.clone({ uuid: src, name: "x" })).rejects.toThrow(/NO_ACCESS/);
    await friend.api.subusers.invite({ uuid: src, who: sub.discordId, permissions: ["console.read", "power", "files.read", "files.write"] });
    await expect(sub.api.servers.clone({ uuid: src, name: "x" })).rejects.toThrow(/OWNER_ONLY/);
    await expect(sub.api.servers.cloneOptions({ uuid: src })).rejects.toThrow(/OWNER_ONLY/);

    // Quotum: 4 servers, bron telt mee → nog 3 kopieën.
    for (const n of ["a", "b", "c"]) expect((await done(friend, (await friend.api.servers.clone({ uuid: src, name: n })).id)).status).toBe("succeeded");
    await expect(friend.api.servers.clone({ uuid: src, name: "d" })).rejects.toThrow(/QUOTA_EXCEEDED: servers/);
    // Poorten: quotum staat 2 per server toe; een bron met 3 (admin gaf ze) mag niet gekopieerd worden.
    await getDb().update(schema.userQuotas).set({ maxServers: 10, maxPortsPerServer: 1 }).where(eq(schema.userQuotas.userId, friend.id));
    const big = await admin.api.admin.servers.create({ name: "Groot", ownerId: friend.id, nodeId: h.localNodeId, templateId: gameId, limits, allocationIds: [await h.allocation(port++), await h.allocation(port++)], variables: {}, startOnInstall: false });
    h.daemon.servers.get(big.uuid)!.state = "offline";
    await expect(friend.api.servers.clone({ uuid: big.uuid, name: "e" })).rejects.toThrow(/QUOTA_EXCEEDED: ports/);
    await getDb().update(schema.userQuotas).set({ maxServers: Q.maxServers, maxPortsPerServer: Q.maxPortsPerServer }).where(eq(schema.userQuotas.userId, friend.id));
  });

  it("geen vrije poort: NO_FREE_ALLOCATIONS, niets aangemaakt", async () => {
    const src = await gameServer(friend);
    await expect(friend.api.servers.clone({ uuid: src, name: "x" })).rejects.toThrow(/NO_FREE_ALLOCATIONS/);
    expect((await getDb().select().from(schema.servers)).length).toBe(1);
  });

  it("admin: andere eigenaar en node, via de tar-stroom; geen quotum nodig", async () => {
    const src = await gameServer(nobody);
    const [a2] = await getDb().insert(schema.allocations).values({ nodeId: node2, ip: "0.0.0.0", port: 34001 }).returning();
    const opts = await admin.api.servers.cloneOptions({ uuid: src });
    expect(opts).toMatchObject({ allowed: true, isAdmin: true, quota: null });
    const j = await done(admin, (await admin.api.servers.clone({ uuid: src, name: "Elders", ownerId: stranger.id, nodeId: node2 })).id);
    expect(j).toMatchObject({ status: "succeeded", sameNode: false });
    expect(d2.fs(j.target.uuid).files.get("/world/level.dat")).toBe("wereld");
    expect(d2.servers.get(j.target.uuid)!.spec.allocations).toEqual([{ ip: "0.0.0.0", port: 34001, primary: true }]);
    const row = (await srvRow(j.target.uuid))!;
    expect(row).toMatchObject({ ownerId: stranger.id, nodeId: node2 });
    const [alloc] = await getDb().select().from(schema.allocations).where(eq(schema.allocations.id, a2!.id));
    expect(alloc!.serverId).toBe(row.id);
    // Melding naar de admin (gestart) én de nieuwe eigenaar.
    // De melding wordt asynchroon geschreven: onder load even wachten.
    await vi.waitFor(async () => expect((await inbox(stranger)).some((m) => m.event === "server_cloned")).toBe(true), { timeout: 10_000, interval: 100 });
    expect((await stranger.api.servers.get({ uuid: j.target.uuid })).isOwner).toBe(true);
  });
});

describe("servers.clone: fouten en annuleren", () => {
  it("kopie mislukt: doel weg, poort vrij, bron ongemoeid, melding", async () => {
    const src = await gameServer(friend);
    const free = await h.allocation(port++);
    h.daemon.exportFails = true;
    const j = await done(friend, (await friend.api.servers.clone({ uuid: src, name: "Kapot" })).id);
    expect(j).toMatchObject({ status: "failed", target: { exists: false } });
    expect(j.error).toMatch(/kapot/);
    expect(j.steps.find((s) => s.key === "files")!.status).toBe("failed");
    expect(await srvRow(j.target.uuid)).toBeUndefined();
    expect(h.daemon.servers.has(j.target.uuid)).toBe(false);
    const [a] = await getDb().select().from(schema.allocations).where(eq(schema.allocations.id, free));
    expect(a!.serverId).toBeNull();
    expect(h.daemon.fs(src).files.get("/world/level.dat")).toBe("wereld");
    await vi.waitFor(async () => expect((await inbox(friend)).some((m) => m.event === "server_cloned" && m.title === "Server copy failed")).toBe(true), { timeout: 10_000, interval: 100 });
  });

  it("annuleren tijdens het kopiëren: doel weg; power op het doel geblokkeerd zolang het loopt", async () => {
    const src = await gameServer(friend);
    await h.allocation(port++);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    h.daemon.transferHold = () => (entered(), held);
    const job = await friend.api.servers.clone({ uuid: src, name: "Weg" });
    await inside;
    await expect(friend.api.servers.power({ uuid: job.target.uuid, action: "start" })).rejects.toThrow(/CLONE_IN_PROGRESS/);
    await expect(friend.api.servers.clone({ uuid: src, name: "Nog een" })).rejects.toThrow(/CLONE_IN_PROGRESS/);
    await expect(stranger.api.servers.cancelClone({ id: job.id })).rejects.toThrow(/JOB_NOT_FOUND/);
    await friend.api.servers.cancelClone({ id: job.id });
    release();
    const j = await done(friend, job.id);
    expect(j.status).toBe("canceled");
    expect(await srvRow(j.target.uuid)).toBeUndefined();
    await expect(friend.api.servers.cancelClone({ id: job.id })).rejects.toThrow(/CLONE_NOT_RUNNING/);
    // Geen melding bij zelf annuleren.
    expect((await inbox(friend)).some((m) => m.event === "server_cloned")).toBe(false);
  });

  it("onderbroken taak (panel herstart): bij het opvragen mislukt en opgeruimd", async () => {
    const src = await gameServer(friend);
    const srcRow = (await srvRow(src))!;
    const [t] = await getDb().insert(schema.servers).values({ name: "Half", ownerId: friend.id, nodeId: h.localNodeId, templateId: gameId, type: "game", cpuPct: 100, ramMb: 512, diskMb: 1024, status: "installing" }).returning();
    const [row] = await getDb()
      .insert(schema.serverClones)
      .values({ sourceServerId: srcRow.id, targetServerId: t!.id, sourceUuid: src, targetUuid: t!.uuid, sourceName: "Bron", targetName: "Half", userId: friend.id, options: { copyDatabases: false, domain: null, startAfter: false, sameNode: true, live: false }, steps: [{ key: "files", status: "running" }] })
      .returning();
    const j = await friend.api.servers.cloneJob({ id: row!.id });
    expect(j).toMatchObject({ status: "failed", errorCode: "INTERRUPTED" });
    expect(await srvRow(t!.uuid)).toBeUndefined();
  });
});

describe("servers.clone: website met database en domein", () => {
  let host = 0;
  beforeAll(async () => {
    const db = getDb();
    await db.delete(schema.databaseHosts);
    const [hst] = await db.insert(schema.databaseHosts).values({ name: "local", host: "panel-mariadb", port: 3306, adminUser: "", adminPasswordEnc: "x", nodeId: h.localNodeId, daemonManaged: true }).returning();
    host = hst!.id;
  });

  it("nieuwe database + gebruiker met de inhoud, nieuw domein, waarschuwing over de config", async () => {
    const site = await admin.api.admin.servers.create({ name: "Site", ownerId: friend.id, nodeId: h.localNodeId, templateId: webId, limits, allocationIds: [], variables: {}, startOnInstall: false });
    h.daemon.servers.get(site.uuid)!.state = "online";
    h.daemon.fs(site.uuid).files.set("/public/index.php", "<?php echo 1;");
    const srcRow = (await srvRow(site.uuid))!;
    const name = `s${site.uuid.slice(0, 8)}_wordpress`;
    await getDb().insert(schema.databases).values({ serverId: srcRow.id, hostId: host, name, username: "u_old", passwordEnc: encrypt("geheim-wachtwoord") });
    h.daemon.dbs.set(name, { username: "u_old", password: "geheim-wachtwoord", data: "-- dump\nCREATE TABLE wp_posts;" });
    await getDb().insert(schema.domains).values({ serverId: srcRow.id, hostname: "site.panel.test", targetPort: null });

    const opts = await friend.api.servers.cloneOptions({ uuid: site.uuid });
    expect(opts.databases).toEqual([{ name, copyable: true }]);
    expect(opts.notes).toEqual(expect.arrayContaining(["live_copy", "domains_not_cloned"]));
    await expect(friend.api.servers.clone({ uuid: site.uuid, name: "x", domain: "site.panel.test" })).rejects.toThrow(/DOMAIN_TAKEN/);

    const j = await done(friend, (await friend.api.servers.clone({ uuid: site.uuid, name: "Site staging", copyDatabases: true, domain: "staging.panel.test" })).id);
    expect(j.status).toBe("succeeded");
    expect(j.databases).toHaveLength(1);
    const copy = j.databases[0]!;
    expect(copy.from).toBe(name);
    expect(copy.to).toBe(`s${j.target.uuid.slice(0, 8)}_wordpress`);
    expect(copy.username).not.toBe("u_old");
    expect(h.daemon.dbs.get(copy.to)!.data).toBe("-- dump\nCREATE TABLE wp_posts;");
    expect(h.daemon.dbs.get(name)!.data).toBe("-- dump\nCREATE TABLE wp_posts;"); // bron ongemoeid
    expect(j.warnings.some((w) => /Configuration files still point/.test(w))).toBe(true);
    expect(h.daemon.fs(j.target.uuid).files.get("/public/index.php")).toBe("<?php echo 1;");
    expect(h.daemon.routes.get("staging.panel.test")).toMatchObject({ server_uuid: j.target.uuid });
    expect(h.daemon.routes.get("site.panel.test")).toBeUndefined(); // oude domein gaat niet mee
    const doms = await friend.api.domains.list({ uuid: j.target.uuid });
    expect(doms.map((d) => d.hostname)).toEqual(["staging.panel.test"]);
    const dbs = await friend.api.databases.list({ uuid: j.target.uuid });
    expect(dbs.map((d) => d.name)).toEqual([copy.to]);
  });

  it("databasequotum telt mee; mislukte import ruimt de nieuwe database op", async () => {
    await getDb().update(schema.userQuotas).set({ maxDatabases: 1 }).where(eq(schema.userQuotas.userId, friend.id));
    const site = await admin.api.admin.servers.create({ name: "Site2", ownerId: friend.id, nodeId: h.localNodeId, templateId: webId, limits, allocationIds: [], variables: {}, startOnInstall: false });
    h.daemon.servers.get(site.uuid)!.state = "offline";
    const srcRow = (await srvRow(site.uuid))!;
    const name = `s${site.uuid.slice(0, 8)}_app`;
    await getDb().insert(schema.databases).values({ serverId: srcRow.id, hostId: host, name, username: "u_app", passwordEnc: encrypt("geheim-wachtwoord") });
    h.daemon.dbs.set(name, { username: "u_app", password: "x", data: "-- app" });
    await expect(friend.api.servers.clone({ uuid: site.uuid, name: "x", copyDatabases: true })).rejects.toThrow(/QUOTA_EXCEEDED: databases/);
    // Zonder databases mag het wel.
    expect((await done(friend, (await friend.api.servers.clone({ uuid: site.uuid, name: "zonder db" })).id)).status).toBe("succeeded");
    await getDb().update(schema.userQuotas).set({ maxDatabases: 5 }).where(eq(schema.userQuotas.userId, friend.id));
    h.daemon.dbImportFails = true;
    const j = await done(friend, (await friend.api.servers.clone({ uuid: site.uuid, name: "y", copyDatabases: true })).id);
    expect(j.status).toBe("failed");
    expect([...h.daemon.dbs.keys()]).toEqual([name]);
    const left = await getDb().select().from(schema.databases).where(and(eq(schema.databases.hostId, host)));
    expect(left.map((d) => d.name)).toEqual([name]);
    await getDb().update(schema.userQuotas).set({ maxDatabases: Q.maxDatabases }).where(eq(schema.userQuotas.userId, friend.id));
  });
});
