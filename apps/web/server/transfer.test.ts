import type { DaemonServerState } from "@panel/api";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { daemonUrlOverrides } from "./daemon";
import { encrypt } from "./lib/crypto";
import { getDb, schema } from "./db";
import { transferPollMs } from "./routers/transfer";
import { FakeDaemon } from "./test/fake-daemon";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser;
let d2: FakeDaemon;
let node2 = 0;
let gameId = 0, webId = 0;
let port = 26000;
const limits = { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 };

beforeAll(async () => {
  transferPollMs.value = 10;
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "290000000000000001", name: "speler" });
  gameId = await h.templateId("testgame");
  webId = await h.templateId("testweb");
  const n = await admin.api.admin.nodes.create({ name: "node2", fqdn: "node2.test", daemonPort: 8080, sftpPort: 2023, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null });
  node2 = n.node.id;
  d2 = new FakeDaemon(n.token);
  daemonUrlOverrides.set(node2, await d2.start());
});
afterAll(async () => {
  daemonUrlOverrides.clear();
  await d2.stop();
});
beforeEach(async () => {
  d2.reset();
  await getDb().delete(schema.allocations).where(and(eq(schema.allocations.nodeId, node2), isNull(schema.allocations.serverId)));
});

async function gameServer(state: DaemonServerState["state"] = "offline") {
  const s = await admin.api.admin.servers.create({ name: "T", ownerId: player.id, nodeId: h.localNodeId, templateId: gameId, limits, allocationIds: [await h.allocation(port++)], variables: {}, startOnInstall: false });
  h.daemon.servers.get(s.uuid)!.state = state;
  h.daemon.fs(s.uuid).files.set("/world/level.dat", "wereld");
  h.daemon.fs(s.uuid).dirs.add("/world");
  return s.uuid;
}
const node2Alloc = async (p: number) => {
  const [a] = await getDb().insert(schema.allocations).values({ nodeId: node2, ip: "0.0.0.0", port: p }).returning();
  return a!.id;
};
const row = async (uuid: string) => (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid)))[0]!;

describe("admin.servers.transfer", () => {
  it("verplaatst een draaiende game-server: stop, kopie, nieuwe allocation, start, bron weg", async () => {
    const uuid = await gameServer("online");
    const a1 = await node2Alloc(27001);
    await node2Alloc(27002);
    await admin.api.admin.servers.transfer({ uuid, nodeId: node2 });

    expect((await row(uuid)).nodeId).toBe(node2);
    expect(h.daemon.servers.has(uuid)).toBe(false); // bron verwijderd
    expect(h.daemon.requests.some((r) => r.method === "POST" && r.path === `/api/servers/${uuid}/power` && (r.body as { action: string }).action === "stop")).toBe(true);
    const t = d2.servers.get(uuid)!;
    expect(t.spec.skip_install).toBe(true);
    expect(t.spec.allocations).toEqual([{ ip: "0.0.0.0", port: 27001, primary: true }]);
    expect(t.state).toBe("starting"); // weer gestart
    expect(d2.fs(uuid).files.get("/world/level.dat")).toBe("wereld");
    const allocs = await getDb().select().from(schema.allocations).where(eq(schema.allocations.serverId, (await row(uuid)).id));
    expect(allocs.map((a) => a.id)).toEqual([a1]);
    expect((await admin.api.admin.allocations.list({ nodeId: h.localNodeId })).filter((a) => a.serverUuid === uuid)).toEqual([]);
    const log = await admin.api.admin.activity.search({ serverUuid: uuid });
    expect(log.items.map((i) => i.action)).toContain("admin.server.transfer");
  });

  it("gestopte server blijft gestopt; opgegeven allocation wordt gebruikt", async () => {
    const uuid = await gameServer("offline");
    await node2Alloc(27011);
    const pick = await node2Alloc(27012);
    await admin.api.admin.servers.transfer({ uuid, nodeId: node2, allocationIds: [pick] });
    expect(d2.servers.get(uuid)!.spec.allocations[0]!.port).toBe(27012);
    expect(d2.servers.get(uuid)!.state).not.toBe("starting");
    expect(h.daemon.requests.some((r) => r.path === `/api/servers/${uuid}/power`)).toBe(false);
  });

  it("fout bij kopiëren: bron intact (en weer gestart), doel opgeruimd, allocations ongewijzigd", async () => {
    const uuid = await gameServer("online");
    await node2Alloc(27021);
    h.daemon.exportFails = true;
    await expect(admin.api.admin.servers.transfer({ uuid, nodeId: node2 })).rejects.toThrow();
    h.daemon.exportFails = false;
    const r = await row(uuid);
    expect(r.nodeId).toBe(h.localNodeId);
    expect(h.daemon.servers.has(uuid)).toBe(true);
    expect(h.daemon.servers.get(uuid)!.state).toBe("starting"); // was gestopt, weer gestart
    expect(d2.servers.has(uuid)).toBe(false);
    expect((await admin.api.admin.allocations.list({ nodeId: h.localNodeId })).some((a) => a.serverUuid === uuid)).toBe(true);
    // en daarna lukt het alsnog
    h.daemon.servers.get(uuid)!.state = "offline";
    await admin.api.admin.servers.transfer({ uuid, nodeId: node2 });
    expect((await row(uuid)).nodeId).toBe(node2);
  });

  it("doel vol (507): terugdraaien", async () => {
    const uuid = await gameServer("offline");
    await node2Alloc(27031);
    d2.diskFull = true;
    await expect(admin.api.admin.servers.transfer({ uuid, nodeId: node2 })).rejects.toThrow(/DISK_EXCEEDED/);
    expect((await row(uuid)).nodeId).toBe(h.localNodeId);
    expect(h.daemon.servers.has(uuid)).toBe(true);
    expect(d2.servers.has(uuid)).toBe(false);
  });

  it("controles: dezelfde node, geen vrije allocation, doel onbereikbaar, niet-admin", async () => {
    const uuid = await gameServer("offline");
    await expect(admin.api.admin.servers.transfer({ uuid, nodeId: h.localNodeId })).rejects.toThrow(/SAME_NODE/);
    await expect(admin.api.admin.servers.transfer({ uuid, nodeId: node2 })).rejects.toThrow(/NO_FREE_ALLOCATION/);
    await expect(admin.api.admin.servers.transfer({ uuid, nodeId: 99999 })).rejects.toThrow(/NODE_NOT_FOUND/);
    await node2Alloc(27041);
    d2.mode = "hang";
    daemonUrlOverrides.set(node2, "http://127.0.0.1:1");
    await expect(admin.api.admin.servers.transfer({ uuid, nodeId: node2 })).rejects.toThrow(/DAEMON_UNREACHABLE/);
    daemonUrlOverrides.set(node2, d2.url);
    d2.mode = "ok";
    await expect(player.api.admin.servers.transfer({ uuid, nodeId: node2 })).rejects.toThrow(/NOT_ADMIN/);
    expect((await row(uuid)).nodeId).toBe(h.localNodeId);
  });

  it("web-server: geen allocations, routes verhuizen naar het doel", async () => {
    const s = await admin.api.admin.servers.create({ name: "W", ownerId: player.id, nodeId: h.localNodeId, templateId: webId, limits, allocationIds: [], variables: {}, startOnInstall: false });
    h.daemon.servers.get(s.uuid)!.state = "offline";
    const [srv] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, s.uuid));
    await getDb().insert(schema.domains).values({ serverId: srv!.id, hostname: "klant.panel.test", targetPort: 8080 });
    h.daemon.routes.set("klant.panel.test", { host: "klant.panel.test", server_uuid: s.uuid });
    await admin.api.admin.servers.transfer({ uuid: s.uuid, nodeId: node2 });
    expect((await row(s.uuid)).nodeId).toBe(node2);
    expect(d2.routes.get("klant.panel.test")).toMatchObject({ host: "klant.panel.test", server_uuid: s.uuid });
    expect(h.daemon.servers.has(s.uuid)).toBe(false);
  });

});

describe("admin.servers.transfer met databases", () => {
  let srcHost = 0, dstHost = 0;
  beforeAll(async () => {
    const db = getDb();
    await db.delete(schema.databaseHosts);
    const mk = (name: string, nodeId: number | null, managed: boolean) =>
      db.insert(schema.databaseHosts).values({ name, host: "panel-mariadb", port: 3306, adminUser: "", adminPasswordEnc: "x", nodeId, daemonManaged: managed }).returning().then((r) => r[0]!.id);
    srcHost = await mk("local", h.localNodeId, true);
    dstHost = await mk("node2", node2, true);
  });
  const addDb = async (uuid: string, name: string, hostId = srcHost) => {
    const srv = await row(uuid);
    const [d] = await getDb().insert(schema.databases).values({ serverId: srv.id, hostId, name, username: "u_" + name, passwordEnc: encrypt("pw-" + name + "-secret") }).returning();
    return d!;
  };
  const dbRow = async (id: number) => (await getDb().select().from(schema.databases).where(eq(schema.databases.id, id)))[0]!;

  it("databases.create gebruikt de MariaDB van de node van de server (via de daemon)", async () => {
    const uuid = await gameServer("offline");
    const d = await admin.api.databases.create({ uuid, name: "app", hostId: null });
    expect(d.hostId).toBe(srcHost);
    expect(h.daemon.dbs.get(d.name)).toMatchObject({ username: d.username, password: d.password });
    expect(d2.dbs.size).toBe(0);
    await admin.api.databases.resetPassword({ id: d.id });
    expect(h.daemon.dbs.get(d.name)!.password).not.toBe(d.password);
    await admin.api.databases.delete({ id: d.id });
    expect(h.daemon.dbs.size).toBe(0);
  });

  it("verplaatst databases mee: zelfde naam, gebruiker, wachtwoord en inhoud; bron opgeruimd; host_id bijgewerkt", async () => {
    const uuid = await gameServer("offline");
    await node2Alloc(27061);
    const d = await addDb(uuid, "d" + uuid.slice(0, 6));
    h.daemon.dbs.set(d.name, { username: d.username, password: "pw-" + d.name + "-secret", data: "-- dump\nCREATE TABLE t;" });
    await admin.api.admin.servers.transfer({ uuid, nodeId: node2 });
    expect((await row(uuid)).nodeId).toBe(node2);
    expect(d2.dbs.get(d.name)).toEqual({ username: d.username, password: "pw-" + d.name + "-secret", data: "-- dump\nCREATE TABLE t;" });
    expect(h.daemon.dbs.has(d.name)).toBe(false);
    const after = await dbRow(d.id);
    expect(after.hostId).toBe(dstHost);
    expect(after.passwordEnc).toBe(d.passwordEnc);
    // het panel toont nu de host van het doel (zelfde naam waaronder de site hem bereikt)
    const listed = await admin.api.databases.list({ uuid });
    expect(listed[0]).toMatchObject({ hostId: dstHost, host: "panel-mariadb", port: 3306, password: "pw-" + d.name + "-secret" });
  });

  it("fout bij de import: bron en databases intact, doel opgeruimd, host_id ongewijzigd", async () => {
    const uuid = await gameServer("online");
    await node2Alloc(27071);
    const d = await addDb(uuid, "e" + uuid.slice(0, 6));
    h.daemon.dbs.set(d.name, { username: d.username, password: "pw", data: "-- dump" });
    d2.dbImportFails = true;
    await expect(admin.api.admin.servers.transfer({ uuid, nodeId: node2 })).rejects.toThrow(/IMPORT_FAILED/i);
    d2.dbImportFails = false;
    expect((await row(uuid)).nodeId).toBe(h.localNodeId);
    expect(h.daemon.servers.has(uuid)).toBe(true);
    expect(h.daemon.servers.get(uuid)!.state).toBe("starting");
    expect(h.daemon.dbs.get(d.name)!.data).toBe("-- dump");
    expect(d2.dbs.size).toBe(0);
    expect(d2.servers.has(uuid)).toBe(false);
    expect((await dbRow(d.id)).hostId).toBe(srcHost);
  });

  it("dump mislukt of een database met die naam bestaat al op het doel: niets weggegooid, niets verplaatst", async () => {
    const uuid = await gameServer("offline");
    await node2Alloc(27081);
    const d = await addDb(uuid, "f" + uuid.slice(0, 6));
    h.daemon.dbs.set(d.name, { username: d.username, password: "pw", data: "-- dump" });
    h.daemon.dbDumpFails = true;
    await expect(admin.api.admin.servers.transfer({ uuid, nodeId: node2 })).rejects.toThrow();
    h.daemon.dbDumpFails = false;
    expect(d2.dbs.size).toBe(0);
    // Bestaande database op het doel (andere eigenaar) blijft staan.
    d2.dbs.set(d.name, { username: "ander", password: "x", data: "bestaand" });
    await expect(admin.api.admin.servers.transfer({ uuid, nodeId: node2 })).rejects.toThrow(/EXISTS/i);
    expect(d2.dbs.get(d.name)!.data).toBe("bestaand");
    expect(h.daemon.dbs.has(d.name)).toBe(true);
    expect((await row(uuid)).nodeId).toBe(h.localNodeId);
    expect((await dbRow(d.id)).hostId).toBe(srcHost);
  });

  it("doelnode zonder MariaDB: duidelijke fout vooraf; externe hosts en niet-beheerde node-hosts", async () => {
    const uuid = await gameServer("offline");
    await node2Alloc(27091);
    const d = await addDb(uuid, "g" + uuid.slice(0, 6));
    await getDb().update(schema.databaseHosts).set({ daemonManaged: false }).where(eq(schema.databaseHosts.id, dstHost));
    await getDb().update(schema.databaseHosts).set({ daemonManaged: false }).where(eq(schema.databaseHosts.id, srcHost));
    await expect(admin.api.admin.servers.transfer({ uuid, nodeId: node2 })).rejects.toThrow(/DATABASE_HOST_NOT_DAEMON_MANAGED/);
    await getDb().update(schema.databaseHosts).set({ daemonManaged: true }).where(eq(schema.databaseHosts.id, srcHost));
    await expect(admin.api.admin.servers.transfer({ uuid, nodeId: node2 })).rejects.toThrow(/NO_DATABASE_HOST_ON_TARGET/);
    // Een externe host (geen node) gaat niet mee en blijft ongewijzigd.
    await getDb().update(schema.databaseHosts).set({ daemonManaged: true }).where(eq(schema.databaseHosts.id, dstHost));
    const [ext] = await getDb().insert(schema.databaseHosts).values({ name: "ext", host: "db.example.test", port: 3306, adminUser: "root", adminPasswordEnc: "x", nodeId: null }).returning();
    await getDb().update(schema.databases).set({ hostId: ext!.id }).where(eq(schema.databases.id, d.id));
    await admin.api.admin.servers.transfer({ uuid, nodeId: node2 });
    expect((await dbRow(d.id)).hostId).toBe(ext!.id);
    expect(d2.dbs.size).toBe(0);
    await getDb().update(schema.databases).set({ hostId: srcHost }).where(eq(schema.databases.id, d.id));
  });
});
