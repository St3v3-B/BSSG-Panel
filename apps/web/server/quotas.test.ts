import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { reserveDatabase } from "./routers/quotas";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, friend: TestUser, other: TestUser, nobody: TestUser;
let gameId = 0, webId = 0;

const Q = { maxRamMb: 2048, maxDiskMb: 4096, maxCpuPct: 300, maxServers: 3, maxDatabases: 1, templateIds: null, nodeIds: null, maxPortsPerServer: 2 };
const lim = (ramMb = 512, diskMb = 1024, cpuPct = 100) => ({ ramMb, diskMb, cpuPct });
const mk = (u: TestUser, name: string, o: Partial<{ templateId: number; nodeId: number; limits: ReturnType<typeof lim>; ports: number }> = {}) =>
  u.api.servers.create({ name, templateId: o.templateId ?? gameId, nodeId: o.nodeId ?? h.localNodeId, limits: o.limits ?? lim(), ports: o.ports ?? 1, variables: {} });

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  friend = await h.user({ discordId: "290000000000000001", name: "vriend" });
  other = await h.user({ discordId: "290000000000000002", name: "ander" });
  nobody = await h.user({ discordId: "290000000000000003", name: "zonder" });
  gameId = await h.templateId("testgame");
  webId = await h.templateId("testweb");
  for (let p = 31000; p < 31010; p++) await h.allocation(p);
  await admin.api.admin.users.setQuota({ id: friend.id, ...Q });
  await admin.api.admin.users.setQuota({ id: other.id, ...Q, maxServers: 10, maxRamMb: 100000, maxDiskMb: 100000, maxCpuPct: 10000 });
});

describe("quotum", () => {
  it("zonder quotum: account.quota null en create → NO_QUOTA", async () => {
    expect(await nobody.api.account.quota()).toBeNull();
    await expect(mk(nobody, "x")).rejects.toThrow(/NO_QUOTA/);
  });

  it("admin-procedures zijn alleen voor admins; get/set/clear + log", async () => {
    await expect(friend.api.admin.users.setQuota({ id: friend.id, ...Q })).rejects.toThrow(/NOT_ADMIN/);
    expect(await admin.api.admin.users.getQuota({ id: friend.id })).toEqual(Q);
    expect(await admin.api.admin.users.getQuota({ id: nobody.id })).toBeNull();
    await expect(admin.api.admin.users.setQuota({ id: friend.id, ...Q, templateIds: [9999] })).rejects.toThrow(/TEMPLATE_NOT_FOUND/);
    const log = await admin.api.admin.activity.search({ action: "admin.user.quota" });
    expect(log.items[0]!.action).toBe("admin.user.quota.set");
  });

  it("create: kiest de eerste vrije poort, telt het verbruik, logt", async () => {
    const d = await mk(friend, "Eerste", { ports: 2 });
    expect(d.owner.id).toBe(friend.id);
    const specs = [...h.daemon.servers.values()].filter((s) => s.spec.uuid === d.uuid);
    expect(specs).toHaveLength(1);
    const allocs = await getDb().select().from(schema.allocations).where(eq(schema.allocations.serverId, (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, d.uuid)))[0]!.id));
    expect(allocs.map((a) => a.port).sort()).toEqual([31000, 31001]);
    expect(allocs.find((a) => a.isPrimary)!.port).toBe(31000);
    const o = (await friend.api.account.quota())!;
    expect(o.usage).toEqual({ ramMb: 512, diskMb: 1024, cpuPct: 100, servers: 1, databases: 0 });
    expect(o.templates.map((t) => t.id).sort()).toEqual([gameId, webId].sort());
    const log = await admin.api.admin.activity.search({ action: "server.create" });
    expect(log.items[0]).toMatchObject({ action: "server.create", user: expect.objectContaining({ id: friend.id }) });
  });

  it("boven het quotum: ram, disk, cpu, servers, poorten", async () => {
    await expect(mk(friend, "a", { limits: lim(2000) })).rejects.toThrow(/QUOTA_EXCEEDED: ram/);
    await expect(mk(friend, "a", { limits: lim(512, 4000) })).rejects.toThrow(/QUOTA_EXCEEDED: disk/);
    await expect(mk(friend, "a", { limits: lim(512, 1024, 250) })).rejects.toThrow(/QUOTA_EXCEEDED: cpu/);
    await expect(mk(friend, "a", { ports: 3 })).rejects.toThrow(/QUOTA_EXCEEDED: ports/);
    await mk(friend, "Tweede", { templateId: webId });
    await mk(friend, "Derde", { templateId: webId, limits: lim(64, 64, 10) });
    await expect(mk(friend, "Vierde", { templateId: webId, limits: lim(64, 64, 10) })).rejects.toThrow(/QUOTA_EXCEEDED: servers/);
  });

  it("template/node niet toegestaan", async () => {
    const [n2] = await getDb().insert(schema.nodes).values({ name: "tweede", fqdn: "node2.test", tokenHash: "tweede" }).returning();
    await admin.api.admin.users.setQuota({ id: nobody.id, ...Q, templateIds: [webId], nodeIds: [n2!.id] });
    await expect(mk(nobody, "a")).rejects.toThrow(/TEMPLATE_NOT_ALLOWED/);
    await expect(mk(nobody, "a", { templateId: webId })).rejects.toThrow(/NODE_NOT_ALLOWED/);
    const o = (await nobody.api.account.quota())!;
    expect(o.templates.map((t) => t.id)).toEqual([webId]);
    expect(o.nodes.map((n) => n.name)).toEqual(["tweede"]);
    await admin.api.admin.users.clearQuota({ id: nobody.id });
    expect(await nobody.api.account.quota()).toBeNull();
  });

  it("parallelle creates overschrijden het quotum niet, en verdelen poorten zonder dubbelen", async () => {
    await admin.api.admin.users.setQuota({ id: other.id, ...Q, maxServers: 3, maxRamMb: 100000, maxDiskMb: 100000, maxCpuPct: 10000, maxPortsPerServer: 1 });
    const res = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => mk(other, `race${i}`)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of res.filter((x) => x.status === "rejected")) expect((r as PromiseRejectedResult).reason.message).toMatch(/QUOTA_EXCEEDED: servers/);
    expect((await other.api.account.quota())!.usage.servers).toBe(3);
    const used = await getDb().select().from(schema.allocations);
    const ports = used.filter((a) => a.serverId !== null).map((a) => a.port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("parallel op RAM: totaal blijft binnen het quotum", async () => {
    await admin.api.admin.users.setQuota({ id: nobody.id, ...Q, maxServers: 10, maxRamMb: 1000, maxCpuPct: 10000, maxDiskMb: 100000, maxPortsPerServer: null });
    const res = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => mk(nobody, `ram${i}`, { templateId: webId, limits: lim(400) })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await nobody.api.account.quota())!.usage.ramMb).toBe(800);
  });

  it("geen vrije poorten → NO_FREE_ALLOCATIONS en niets achtergebleven; daemonfout draait terug", async () => {
    const [n] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.fqdn, "node2.test"));
    await admin.api.admin.users.setQuota({ id: friend.id, ...Q, maxServers: 10, maxRamMb: 100000, maxDiskMb: 100000, maxCpuPct: 10000 });
    await expect(mk(friend, "geen", { nodeId: n!.id })).rejects.toThrow(/NO_FREE_ALLOCATIONS/);
    const before = (await friend.api.account.quota())!.usage.servers;
    h.daemon.mode = "error500";
    await expect(mk(friend, "kapot", { templateId: webId })).rejects.toThrow();
    h.daemon.mode = "ok";
    expect((await friend.api.account.quota())!.usage.servers).toBe(before);
  });
});

describe("eigen limieten en verwijderen", () => {
  let uuid = "";
  beforeAll(async () => {
    await admin.api.admin.users.setQuota({ id: friend.id, ...Q, maxServers: 10, maxRamMb: 3000, maxDiskMb: 100000, maxCpuPct: 10000 });
    uuid = (await mk(friend, "Wijzig", { templateId: webId, limits: lim(256) })).uuid;
  });

  it("updateOwnLimits binnen quotum; erboven → QUOTA_EXCEEDED; verkleinen mag altijd", async () => {
    const used = (await friend.api.account.quota())!.usage.ramMb;
    await friend.api.servers.updateOwnLimits({ uuid, limits: lim(256 + (3000 - used)) });
    await expect(friend.api.servers.updateOwnLimits({ uuid, limits: lim(256 + (3000 - used) + 1) })).rejects.toThrow(/QUOTA_EXCEEDED: ram/);
    await friend.api.servers.updateOwnLimits({ uuid, limits: lim(128) });
    expect(h.daemon.servers.get(uuid)!.spec.limits.memory_mb).toBe(128);
    expect((await admin.api.admin.activity.search({ action: "server.limits" })).items).toHaveLength(2);
  });

  it("alleen de eigenaar; zonder quotum geweigerd", async () => {
    await expect(other.api.servers.updateOwnLimits({ uuid, limits: lim(128) })).rejects.toThrow();
    await expect(other.api.servers.deleteOwn({ uuid, confirmName: "Wijzig" })).rejects.toThrow();
    await admin.api.admin.users.setQuota({ id: friend.id, ...Q, maxServers: 10, maxRamMb: 3000, maxDiskMb: 100000, maxCpuPct: 10000 });
  });

  it("deleteOwn vereist de exacte naam en geeft het quotum vrij", async () => {
    await expect(friend.api.servers.deleteOwn({ uuid, confirmName: "wijzig" })).rejects.toThrow(/NAME_MISMATCH/);
    const before = (await friend.api.account.quota())!.usage.servers;
    await friend.api.servers.deleteOwn({ uuid, confirmName: "Wijzig" });
    expect((await friend.api.account.quota())!.usage.servers).toBe(before - 1);
    expect(h.daemon.servers.has(uuid)).toBe(false);
    expect((await admin.api.admin.activity.search({ action: "server.delete" })).items).toHaveLength(1);
  });

  it("admin omzeilt quota's: admin.servers.create boven het quotum", async () => {
    const d = await admin.api.admin.servers.create({ name: "Groot", ownerId: friend.id, nodeId: h.localNodeId, templateId: webId, limits: { cpuPct: 100, ramMb: 99999, swapMb: 0, diskMb: 1024 }, allocationIds: [], variables: {}, startOnInstall: true });
    expect(d.limits.ramMb).toBe(99999);
  });
});

describe("databases en overzicht", () => {
  it("reserveDatabase: parallel nooit meer dan maxDatabases", async () => {
    const [host] = await getDb().insert(schema.databaseHosts).values({ name: "q", host: "127.0.0.1", port: 3306, adminUser: "root", adminPasswordEnc: "x" } as never).returning();
    const [srv] = await getDb().select().from(schema.servers).where(eq(schema.servers.ownerId, other.id));
    await admin.api.admin.users.setQuota({ id: other.id, ...Q, maxDatabases: 2 });
    const res = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        reserveDatabase(other.id, async (tx) => (await tx.insert(schema.databases).values({ serverId: srv!.id, hostId: host!.id, name: `d${i}`, username: `u${i}`, passwordEnc: "x" }).returning())[0]!),
      ),
    );
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await other.api.account.quota())!.usage.databases).toBe(2);
    await admin.api.admin.users.setQuota({ id: other.id, ...Q, maxDatabases: 0 });
    await expect(other.api.databases.create({ uuid: srv!.uuid, name: "nee", hostId: host!.id })).rejects.toThrow(/QUOTA_EXCEEDED: databases/);
  });

  it("admin.quotas.usage toont gebruikers met quotum of servers", async () => {
    const page = await admin.api.admin.quotas.usage({ limit: 50 });
    const f = page.items.find((i) => i.user.id === friend.id)!;
    expect(f.quota).toMatchObject({ maxServers: 10 });
    expect(f.usage.servers).toBeGreaterThan(0);
    await expect(friend.api.admin.quotas.usage({ limit: 5 })).rejects.toThrow(/NOT_ADMIN/);
  });
});
