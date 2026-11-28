import type { Ctx } from "@panel/api";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pickNode } from "./billing/core";
import { daemonUrlOverrides } from "./daemon";
import { getDb, schema } from "./db";
import { delivery, flushNotify, resetNotify } from "./notify";
import { evacuationDeps, resumeEvacuations, waitEvacuations } from "./routers/maintenance";
import { transferPollMs } from "./routers/transfer";
import { FakeDaemon } from "./test/fake-daemon";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser, other: TestUser;
let gameId = 0, webId = 0;
let node2 = 0, node3 = 0;
let d2: FakeDaemon;
let port = 33000;
const limits = { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 };
const realTransfer = evacuationDeps.transfer;

beforeAll(async () => {
  transferPollMs.value = 10;
  delivery.inline = true;
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "291000000000000001", name: "speler" });
  other = await h.user({ discordId: "291000000000000002", name: "ander" });
  gameId = await h.templateId("testgame");
  webId = await h.templateId("testweb");
  const n = await admin.api.admin.nodes.create({ name: "node2", fqdn: "node2.test", daemonPort: 8080, sftpPort: 2023, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null, supportsDomains: true });
  node2 = n.node.id;
  d2 = new FakeDaemon(n.token);
  daemonUrlOverrides.set(node2, await d2.start());
  // node3: klein en zonder domeinen.
  const n3 = await admin.api.admin.nodes.create({ name: "node3", fqdn: "node3.test", daemonPort: 8080, sftpPort: 2024, maxRamMb: 1024, maxDiskMb: 10_000, s3TargetId: null, supportsDomains: false, publicPort: 8443 });
  node3 = n3.node.id;
});
afterAll(async () => {
  daemonUrlOverrides.clear();
  await d2.stop();
});
beforeEach(async () => {
  resetNotify();
  evacuationDeps.transfer = realTransfer;
  d2.reset();
  const db = getDb();
  await db.update(schema.nodes).set({ maintenance: null });
  await db.delete(schema.nodeEvacuations);
});

const alloc = async (nodeId: number, p = port++) => (await getDb().insert(schema.allocations).values({ nodeId, ip: "0.0.0.0", port: p }).returning())[0]!.id;
async function gameServer(o: { state?: "online" | "offline"; ramMb?: number; owner?: TestUser } = {}) {
  const s = await admin.api.admin.servers.create({ name: `G${port}`, ownerId: (o.owner ?? player).id, nodeId: h.localNodeId, templateId: gameId, limits: { ...limits, ramMb: o.ramMb ?? 512 }, allocationIds: [await h.allocation(port++)], variables: {}, startOnInstall: false });
  h.daemon.servers.get(s.uuid)!.state = o.state ?? "offline";
  return s.uuid;
}
const row = async (uuid: string) => (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid)))[0]!;
const setMaint = (id: number, notifyOwners = false) => admin.api.admin.maintenance.set({ id, message: "Nieuwe schijven", plannedStart: new Date("2026-12-01T22:00:00Z"), plannedEnd: new Date("2026-12-02T02:00:00Z"), notifyOwners });

describe("onderhoudsmodus", () => {
  it("node in onderhoud weigert nieuwe servers: admin, quotum, pakketten en transfer naar de node", async () => {
    const n = await setMaint(node2);
    expect(n.maintenance).toMatchObject({ message: "Nieuwe schijven", plannedEnd: new Date("2026-12-02T02:00:00Z") });
    expect((await admin.api.admin.nodes.get({ id: node2 })).maintenance?.since).toBeInstanceOf(Date);
    // admin.servers.create
    await expect(
      admin.api.admin.servers.create({ name: "X", ownerId: player.id, nodeId: node2, templateId: gameId, limits, allocationIds: [await alloc(node2)], variables: {}, startOnInstall: false }),
    ).rejects.toThrow(/NODE_IN_MAINTENANCE/);
    // zelf aanmaken (quotum)
    await admin.api.admin.users.setQuota({ id: other.id, maxRamMb: 4096, maxDiskMb: 8192, maxCpuPct: 400, maxServers: 5, maxDatabases: 1, templateIds: null, nodeIds: null, maxPortsPerServer: 2 });
    await expect(other.api.servers.create({ name: "Q", templateId: gameId, nodeId: node2, limits: { ramMb: 512, diskMb: 1024, cpuPct: 100 }, ports: 1, variables: {} })).rejects.toThrow(/NODE_IN_MAINTENANCE/);
    expect((await other.api.account.quota())!.nodes.map((x) => x.id)).not.toContain(node2);
    // pakketten (pickNode)
    const db = getDb();
    await expect(db.transaction((tx) => pickNode(tx, { type: "game", nodeIds: [node2], ramMb: 64, diskMb: 64, allocations: 1 }))).rejects.toThrow(/NO_CAPACITY/);
    // transfer naar de node
    const uuid = await gameServer();
    await expect(admin.api.admin.servers.transfer({ uuid, nodeId: node2 })).rejects.toThrow(/NODE_IN_MAINTENANCE/);
    // na beëindigen weer wel
    await admin.api.admin.maintenance.end({ id: node2 });
    expect((await admin.api.admin.nodes.get({ id: node2 })).maintenance ?? null).toBeNull();
    await admin.api.admin.servers.create({ name: "X", ownerId: player.id, nodeId: node2, templateId: gameId, limits, allocationIds: [await alloc(node2)], variables: {}, startOnInstall: false });
  });

  it("eigenaar ziet de banner en krijgt één melding met zijn servers; niet-admin mag niet", async () => {
    const a = await gameServer();
    const b = await gameServer();
    await getDb().delete(schema.notifications);
    await setMaint(h.localNodeId, true);
    await flushNotify();
    const s = await player.api.servers.get({ uuid: a });
    expect(s.maintenance).toMatchObject({ message: "Nieuwe schijven", plannedStart: new Date("2026-12-01T22:00:00Z") });
    expect((await player.api.servers.list()).find((x) => x.uuid === b)?.maintenance).toBeTruthy();
    const inbox = await getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, player.id));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ event: "maintenance", title: "Node maintenance" });
    expect(inbox[0]!.body).toContain((await row(a)).name);
    // bijwerken zonder wijziging: geen nieuwe melding
    await setMaint(h.localNodeId, true);
    await flushNotify();
    expect(await getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, player.id))).toHaveLength(1);
    await expect(player.api.admin.maintenance.set({ id: h.localNodeId, message: null, plannedStart: null, plannedEnd: null, notifyOwners: false })).rejects.toThrow(/NOT_ADMIN/);
    await expect(admin.api.admin.maintenance.set({ id: h.localNodeId, message: null, plannedStart: new Date("2026-12-02T00:00:00Z"), plannedEnd: new Date("2026-12-01T00:00:00Z"), notifyOwners: false })).rejects.toThrow(/PLANNED_END_BEFORE_START/);
    await admin.api.admin.maintenance.end({ id: h.localNodeId });
    await flushNotify();
    expect((await player.api.servers.get({ uuid: a })).maintenance ?? null).toBeNull();
    const after = await getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, player.id));
    expect(after.map((x) => x.title)).toContain("Maintenance finished");
  });
});

describe("doelnode kiezen", () => {
  it("plan: vrije RAM, domeinen en allocations; grote servers eerst verdeeld", async () => {
    const db = getDb();
    await db.delete(schema.allocations).where(and(isNull(schema.allocations.serverId), eq(schema.allocations.nodeId, node3)));
    await db.delete(schema.allocations).where(and(isNull(schema.allocations.serverId), eq(schema.allocations.nodeId, node2)));
    await alloc(node3);
    await alloc(node3);
    await alloc(node2);
    const big = await gameServer({ ramMb: 900 });
    const small = await gameServer({ ramMb: 600 });
    const site = await admin.api.admin.servers.create({ name: "Site", ownerId: player.id, nodeId: h.localNodeId, templateId: webId, limits, allocationIds: [], variables: {}, startOnInstall: false });
    const plan = await admin.api.admin.maintenance.plan({ id: h.localNodeId, uuids: [big, small, site.uuid] });
    const item = (u: string) => plan.items.find((i) => i.uuid === u)!;
    // node2 is onbeperkt (meeste ruimte) en heeft één poort: de grootste server krijgt hem; de kleine gaat naar node3 (1024 MB).
    expect(item(big).suggestedNodeId).toBe(node2);
    expect(item(small).suggestedNodeId).toBe(node3);
    // website alleen naar een node met domeinen, en heeft geen poort nodig
    expect(item(site.uuid).allocations).toBe(0);
    expect(item(site.uuid).targets.find((t) => t.nodeId === node3)).toMatchObject({ fits: false, reason: "NO_DOMAINS" });
    expect(item(site.uuid).suggestedNodeId).toBe(node2);
    // node3 te klein voor 2 GB
    const huge = await gameServer({ ramMb: 2048 });
    const p2 = await admin.api.admin.maintenance.plan({ id: h.localNodeId, uuids: [huge] });
    expect(p2.items[0]!.targets.find((t) => t.nodeId === node3)).toMatchObject({ fits: false, reason: "RAM", freeRamMb: 1024 });
    // node in onderhoud is geen doel
    await setMaint(node2);
    const p3 = await admin.api.admin.maintenance.plan({ id: h.localNodeId, uuids: [huge] });
    expect(p3.items[0]!.targets.find((t) => t.nodeId === node2)).toMatchObject({ fits: false, reason: "MAINTENANCE" });
    expect(p3.items[0]!.suggestedNodeId).toBeNull();
  });
});

describe("evacueren", () => {
  /** Nep-transfer: zet de server direct op het doel; `fail` = deze uuids mislukken. */
  function fakeTransfer(o: { fail?: Set<string>; delayMs?: number } = {}) {
    const calls: Array<{ uuid: string; nodeId: number }> = [];
    let active = 0;
    let maxActive = 0;
    evacuationDeps.transfer = async ({ input }: { input: { uuid: string; nodeId: number }; ctx: Ctx }) => {
      calls.push(input);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, o.delayMs ?? 30));
      active--;
      if (o.fail?.has(input.uuid)) throw new Error("TRANSFER_STOP_TIMEOUT: server stays online");
      await getDb().update(schema.servers).set({ nodeId: input.nodeId }).where(eq(schema.servers.uuid, input.uuid));
      return { ok: true };
    };
    return { calls, max: () => maxActive };
  }

  it("zonder onderhoud: NODE_NOT_IN_MAINTENANCE; servers van een andere node: SERVER_NOT_ON_NODE", async () => {
    const a = await gameServer();
    await expect(admin.api.admin.maintenance.evacuate({ id: h.localNodeId, items: [{ uuid: a, nodeId: null }] })).rejects.toThrow(/NODE_NOT_IN_MAINTENANCE/);
    await setMaint(node2);
    await expect(admin.api.admin.maintenance.evacuate({ id: node2, items: [{ uuid: a, nodeId: null }] })).rejects.toThrow(/SERVER_NOT_ON_NODE/);
    await setMaint(h.localNodeId);
    await expect(admin.api.admin.maintenance.evacuate({ id: h.localNodeId, items: [{ uuid: a, nodeId: node2 }] })).rejects.toThrow(/TARGET_INVALID/);
  });

  it("wachtrij: N tegelijk, mislukte blijven op de oude node en worden gemeld, handmatig doel", async () => {
    await getDb().delete(schema.notifications);
    const uuids = [await gameServer(), await gameServer(), await gameServer(), await gameServer()];
    const ft = fakeTransfer({ fail: new Set([uuids[1]!]) });
    await setMaint(h.localNodeId);
    const ev = await admin.api.admin.maintenance.evacuate({ id: h.localNodeId, concurrency: 2, items: [{ uuid: uuids[0]!, nodeId: node3 }, ...uuids.slice(1).map((uuid) => ({ uuid, nodeId: null }))] });
    expect(ev.items.map((i) => i.status)).toEqual(["queued", "queued", "queued", "queued"]);
    await expect(admin.api.admin.maintenance.evacuate({ id: h.localNodeId, items: [{ uuid: uuids[0]!, nodeId: null }] })).rejects.toThrow(/EVACUATION_RUNNING/);
    await waitEvacuations();
    await flushNotify();
    expect(ft.max()).toBe(2);
    expect(ft.calls[0]).toEqual({ uuid: uuids[0], nodeId: node3 });
    const done = (await admin.api.admin.maintenance.evacuation({ id: h.localNodeId }))!;
    expect(done.status).toBe("completed");
    expect(done.items.map((i) => i.status)).toEqual(["done", "failed", "done", "done"]);
    expect(done.items[1]!.error).toMatch(/TRANSFER_STOP_TIMEOUT/);
    expect(done.items[2]!.targetNodeId).not.toBeNull();
    expect((await row(uuids[1]!)).nodeId).toBe(h.localNodeId);
    expect((await row(uuids[0]!)).nodeId).toBe(node3);
    const adminInbox = await getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, admin.id));
    expect(adminInbox.map((x) => x.title)).toContain("Moving a server failed");
    const playerInbox = await getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, player.id));
    expect(playerInbox.filter((x) => x.title === "Server moved to another node")).toHaveLength(3);
  });

  it("annuleren: wachtende vervallen, de lopende maakt zijn verhuizing af; onderhoud beëindigen annuleert ook", async () => {
    const uuids = [await gameServer(), await gameServer(), await gameServer()];
    fakeTransfer({ delayMs: 150 });
    await setMaint(h.localNodeId);
    await admin.api.admin.maintenance.evacuate({ id: h.localNodeId, items: uuids.map((uuid) => ({ uuid, nodeId: node2 })) });
    await new Promise((r) => setTimeout(r, 50));
    const c = await admin.api.admin.maintenance.cancel({ id: h.localNodeId });
    expect(c.status).toBe("cancelled");
    await waitEvacuations();
    const ev = (await admin.api.admin.maintenance.evacuation({ id: h.localNodeId }))!;
    expect(ev.items.map((i) => i.status)).toEqual(["done", "cancelled", "cancelled"]);
    expect(ev.finishedAt).toBeInstanceOf(Date);
    // opnieuw starten en dan onderhoud beëindigen
    await admin.api.admin.maintenance.evacuate({ id: h.localNodeId, items: uuids.slice(1).map((uuid) => ({ uuid, nodeId: node2 })) });
    await new Promise((r) => setTimeout(r, 50));
    await admin.api.admin.maintenance.end({ id: h.localNodeId });
    await waitEvacuations();
    const ev2 = (await admin.api.admin.maintenance.evacuation({ id: h.localNodeId }))!;
    expect(ev2.status).toBe("cancelled");
    expect(ev2.items.map((i) => i.status)).toEqual(["done", "cancelled"]);
    // geen terugverhuizing
    expect((await row(uuids[0]!)).nodeId).toBe(node2);
  });

  it("geen passend doel: mislukt met NO_TARGET, server blijft", async () => {
    fakeTransfer();
    const db = getDb();
    await db.delete(schema.allocations).where(and(isNull(schema.allocations.serverId), eq(schema.allocations.nodeId, node2)));
    await db.delete(schema.allocations).where(and(isNull(schema.allocations.serverId), eq(schema.allocations.nodeId, node3)));
    const a = await gameServer();
    await setMaint(h.localNodeId);
    await admin.api.admin.maintenance.evacuate({ id: h.localNodeId, items: [{ uuid: a, nodeId: null }] });
    await waitEvacuations();
    const ev = (await admin.api.admin.maintenance.evacuation({ id: h.localNodeId }))!;
    expect(ev.items[0]).toMatchObject({ status: "failed" });
    expect(ev.items[0]!.error).toMatch(/NO_TARGET/);
    expect((await row(a)).nodeId).toBe(h.localNodeId);
  });

  it("met de echte transfer: draaiende server staat daarna op de nieuwe node en is weer gestart", async () => {
    const a = await gameServer({ state: "online" });
    h.daemon.fs(a).files.set("/world/level.dat", "wereld");
    await alloc(node2);
    await setMaint(h.localNodeId);
    await admin.api.admin.maintenance.evacuate({ id: h.localNodeId, items: [{ uuid: a, nodeId: node2 }] });
    await waitEvacuations();
    const ev = (await admin.api.admin.maintenance.evacuation({ id: h.localNodeId }))!;
    expect(ev.items[0]).toMatchObject({ status: "done", targetNodeName: "node2" });
    expect(ev.items[0]!.newAddress).toMatch(/:\d+$/);
    expect((await row(a)).nodeId).toBe(node2);
    expect(d2.servers.get(a)!.state).toBe("starting");
    expect(d2.fs(a).files.get("/world/level.dat")).toBe("wereld");
    expect(h.daemon.servers.has(a)).toBe(false);
  });

  it("na een herstart: onderbroken item wordt afgesloten, de rest gaat door", async () => {
    const uuids = [await gameServer(), await gameServer()];
    fakeTransfer();
    await setMaint(h.localNodeId);
    const db = getDb();
    const [ev] = await db.insert(schema.nodeEvacuations).values({ nodeId: h.localNodeId, createdBy: admin.id }).returning();
    await db.insert(schema.nodeEvacuationItems).values([
      { evacuationId: ev!.id, serverUuid: uuids[0]!, serverName: "a", targetNodeId: node2, auto: false, status: "running", position: 0 },
      { evacuationId: ev!.id, serverUuid: uuids[1]!, serverName: "b", targetNodeId: node2, auto: false, status: "queued", position: 1 },
    ]);
    await resumeEvacuations();
    await waitEvacuations();
    const out = (await admin.api.admin.maintenance.evacuation({ id: h.localNodeId }))!;
    expect(out.items.map((i) => i.status)).toEqual(["failed", "done"]);
    expect(out.items[0]!.error).toMatch(/INTERRUPTED/);
    expect(out.status).toBe("completed");
  });
});
