import type { DaemonServerSpec } from "@panel/api";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { parsePorts } from "./routers/admin";
import { GAME_TEMPLATE, OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser, admin2fa_missing: TestUser;
let gameId = 0, webId = 0;

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "220000000000000001", name: "speler" });
  admin2fa_missing = await h.user({ discordId: "220000000000000009", name: "admin zonder 2fa", admin: true });
  gameId = await h.templateId("testgame");
  webId = await h.templateId("testweb");
});

const limits = { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 };

describe("toegang", () => {
  it("niet-admin → NOT_ADMIN, admin zonder 2FA → TOTP_REQUIRED (ook bij directe aanroep)", async () => {
    await expect(player.api.admin.servers.list({})).rejects.toThrow(/NOT_ADMIN/);
    await expect(player.api.admin.servers.delete({ uuid: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/NOT_ADMIN/);
    await expect(player.api.admin.admins.add({ discordId: "220000000000000001" })).rejects.toThrow(/NOT_ADMIN/);
    await expect(admin2fa_missing.api.admin.dashboard()).rejects.toThrow(/TOTP_REQUIRED/);
    await expect((await h.anon()).admin.users.list({})).rejects.toThrow(/UNAUTHORIZED/);
  });
});

describe("admin.nodes / dashboard / settings", () => {
  it("nodes.list en nodes.get (met health van de daemon)", async () => {
    const nodes = await admin.api.admin.nodes.list();
    expect(nodes).toEqual([expect.objectContaining({ isLocal: true, fqdn: "node1.test", sftpPort: 2222 })]);
    const n = await admin.api.admin.nodes.get({ id: nodes[0]!.id });
    expect(n.health).toMatchObject({ online: true, version: "fake-1.0", diskQuotaMode: "soft", cpuCount: 4 });
    expect((await admin.api.admin.nodes.list())[0]!.diskQuotaMode).toBe("soft");
    await expect(admin.api.admin.nodes.get({ id: 9999 })).rejects.toThrow(/NODE_NOT_FOUND/);
  });

  it("dashboard: node offline → melding", async () => {
    let d = await admin.api.admin.dashboard();
    expect(d.nodes[0]!.online).toBe(true);
    expect(d.alerts).toEqual([]);
    expect(d.userCount).toBeGreaterThanOrEqual(3);
    h.daemon.mode = "error500";
    d = await admin.api.admin.dashboard();
    h.daemon.mode = "ok";
    expect(d.nodes[0]!.online).toBe(false);
    expect(d.alerts.map((a) => a.kind)).toEqual(["node_offline"]);
  });

  it("settings.get geeft de standaardwaarden", async () => {
    expect(await admin.api.admin.settings.get()).toMatchObject({ panelName: "Panel", accentColor: "#22c55e", defaultLimits: { ramMb: 2048 } });
  });
});

describe("admin.allocations", () => {
  it("parsePorts", () => {
    expect(parsePorts("25565")).toEqual([25565]);
    expect(parsePorts("25565-25567, 25570")).toEqual([25565, 25566, 25567, 25570]);
    expect(() => parsePorts("0")).toThrow();
    expect(() => parsePorts("10-5")).toThrow();
    expect(() => parsePorts("1-5000")).toThrow(/TOO_MANY/);
    expect(() => parsePorts("abc")).toThrow();
  });

  it("create (dubbele overgeslagen), list, delete (niet als in gebruik)", async () => {
    expect(await admin.api.admin.allocations.create({ nodeId: h.localNodeId, ip: "127.0.0.1", ports: "30000-30004" })).toEqual({ created: 5 });
    expect(await admin.api.admin.allocations.create({ nodeId: h.localNodeId, ip: "127.0.0.1", ports: "30004-30005" })).toEqual({ created: 1 });
    const list = await admin.api.admin.allocations.list({ nodeId: h.localNodeId });
    expect(list.map((a) => a.port)).toEqual([30000, 30001, 30002, 30003, 30004, 30005]);
    await admin.api.admin.allocations.delete({ id: list[5]!.id });
    expect(await admin.api.admin.allocations.list({ nodeId: h.localNodeId })).toHaveLength(5);
    await expect(admin.api.admin.allocations.create({ nodeId: 9999, ip: "127.0.0.1", ports: "1" })).rejects.toThrow(/NODE_NOT_FOUND/);
    const log = await admin.api.admin.activity.search({ action: "admin.allocation" });
    expect(log.items.map((i) => i.action)).toEqual(["admin.allocation.delete", "admin.allocation.create", "admin.allocation.create"]);
  });
});

describe("admin.servers", () => {
  let uuid = "";
  let allocA = 0, allocB = 0, allocC = 0;

  it("create: valideert en stuurt de volledige ServerSpec naar de daemon", async () => {
    allocA = await h.allocation(31000);
    allocB = await h.allocation(31001);
    allocC = await h.allocation(31002);
    const base = { name: "Test", ownerId: player.id, nodeId: h.localNodeId, templateId: gameId, limits, variables: {}, startOnInstall: true };
    await expect(admin.api.admin.servers.create({ ...base, allocationIds: [] })).rejects.toThrow(/ALLOCATION_REQUIRED/);
    await expect(admin.api.admin.servers.create({ ...base, allocationIds: [allocA], ownerId: 9999 })).rejects.toThrow(/OWNER_NOT_FOUND/);
    await expect(admin.api.admin.servers.create({ ...base, allocationIds: [allocA], variables: { JAR_FILE: "nee" } })).rejects.toThrow(/INVALID_VARIABLES/);
    await expect(admin.api.admin.servers.create({ ...base, allocationIds: [allocA], templateId: webId })).rejects.toThrow(/WEB_HAS_NO_ALLOCATIONS/);

    const d = await admin.api.admin.servers.create({ ...base, allocationIds: [allocB, allocA], variables: { SECRET_FLAG: "on" } });
    uuid = d.uuid;
    expect(d).toMatchObject({ status: "installing", owner: { discordId: player.discordId }, primaryAddress: "127.0.0.1:31001", installedAt: null });
    expect(d.allocations.map((a) => [a.port, a.primary])).toEqual([[31001, true], [31000, false]]);
    const spec = h.daemon.last("POST", "/api/servers")!.body as DaemonServerSpec;
    expect(spec).toEqual({
      uuid,
      type: "game",
      image: "example/game:1",
      startup: "java -Xmx{{SERVER_MEMORY}}M -jar {{JAR_FILE}}",
      stop: { type: "command", value: "stop" },
      ready_pattern: "Done \\(",
      environment: { JAR_FILE: "server.jar", SECRET_FLAG: "on" },
      limits: { cpu_pct: 100, memory_mb: 512, swap_mb: 0, disk_mb: 1024, pids: 512 },
      allocations: [{ ip: "127.0.0.1", port: 31001, primary: true }, { ip: "127.0.0.1", port: 31000, primary: false }],
      http_port: null,
      install: { image: "alpine:3.20", script: "#!/bin/sh\necho install\n" },
      config_files: [{ path: "server.properties", format: "properties", set: { "server-port": "{{SERVER_PORT}}" } }],
      start_on_install: true,
      skip_install: false,
      sleep: null,
      image_update: { version_env: null },
    });
    expect(h.daemon.last("POST", "/api/servers")!.auth).toBe(`Bearer ${h.env.NODE_TOKEN}`);
    const log = await admin.api.admin.activity.search({ action: "admin.server.create" });
    expect(log.items.some((e) => e.serverUuid === uuid)).toBe(true);
    expect((await player.api.servers.list()).map((s) => s.uuid)).toContain(uuid);
  });

  it("create: allocation al in gebruik → CONFLICT; daemon weigert → niets in de database", async () => {
    const base = { name: "X", ownerId: player.id, nodeId: h.localNodeId, templateId: gameId, limits, variables: {}, startOnInstall: false };
    await expect(admin.api.admin.servers.create({ ...base, allocationIds: [allocA] })).rejects.toThrow(/ALLOCATION_IN_USE/);
    const before = (await getDb().select().from(schema.servers)).length;
    h.daemon.override = (r) => (r.method === "POST" && r.path === "/api/servers" ? { status: 400, body: { error: "bad_spec", message: "nee" } } : undefined);
    await expect(admin.api.admin.servers.create({ ...base, allocationIds: [allocC] })).rejects.toThrow(/DAEMON_BAD_SPEC/);
    h.daemon.override = null;
    expect(await getDb().select().from(schema.servers)).toHaveLength(before);
    const [c] = await getDb().select().from(schema.allocations).where(eq(schema.allocations.id, allocC));
    expect(c).toMatchObject({ serverId: null, isPrimary: false });
  });

  it("create: web-server zonder allocations met http_port", async () => {
    const d = await admin.api.admin.servers.create({ name: "Site", ownerId: player.id, nodeId: h.localNodeId, templateId: webId, limits, allocationIds: [], variables: {}, startOnInstall: false });
    const spec = h.daemon.last("POST", "/api/servers")!.body as DaemonServerSpec;
    expect(spec).toMatchObject({ type: "web", allocations: [], http_port: 8080, stop: { type: "signal", value: "SIGTERM" }, start_on_install: false });
    expect(d.primaryAddress).toBeNull();
    await admin.api.admin.servers.delete({ uuid: d.uuid });
  });

  it("list: zoeken en pagineren", async () => {
    const all = await admin.api.admin.servers.list({});
    expect(all.items.map((s) => s.uuid)).toContain(uuid);
    expect((await admin.api.admin.servers.list({ search: "tes" })).items.map((s) => s.uuid)).toEqual([uuid]);
    expect((await admin.api.admin.servers.list({ search: uuid.slice(0, 8) })).items).toHaveLength(1);
    expect((await admin.api.admin.servers.list({ search: "bestaatniet" })).items).toEqual([]);
    await admin.api.admin.allocations.create({ nodeId: h.localNodeId, ip: "127.0.0.1", ports: "32000" });
    const a2 = (await admin.api.admin.allocations.list({ nodeId: h.localNodeId })).find((a) => a.port === 32000)!;
    const second = await admin.api.admin.servers.create({ name: "Tweede", ownerId: player.id, nodeId: h.localNodeId, templateId: gameId, limits, allocationIds: [a2.id], variables: {}, startOnInstall: false });
    const p1 = await admin.api.admin.servers.list({ limit: 1 });
    expect(p1.items[0]!.uuid).toBe(second.uuid);
    const p2 = await admin.api.admin.servers.list({ limit: 1, cursor: p1.nextCursor });
    expect(p2.items[0]!.uuid).toBe(uuid);
    await admin.api.admin.servers.delete({ uuid: second.uuid });
  });

  it("updateLimits: PUT naar de daemon met skip_install, daarna database", async () => {
    const nl = { cpuPct: 300, ramMb: 2048, swapMb: -1, diskMb: 0 };
    await admin.api.admin.servers.updateLimits({ uuid, limits: nl });
    const put = h.daemon.last("PUT", `/api/servers/${uuid}`)!.body as DaemonServerSpec;
    expect(put.limits).toEqual({ cpu_pct: 300, memory_mb: 2048, swap_mb: -1, disk_mb: 0, pids: 512 });
    expect(put.skip_install).toBe(true);
    expect(put.environment.SECRET_FLAG).toBe("on");
    expect((await admin.api.admin.servers.list({ search: "Test" })).items[0]!.limits).toEqual(nl);
    h.daemon.mode = "error500";
    await expect(admin.api.admin.servers.updateLimits({ uuid, limits })).rejects.toThrow();
    h.daemon.mode = "ok";
    expect((await admin.api.admin.servers.list({ search: "Test" })).items[0]!.limits).toEqual(nl);
  });

  it("updateAllocations: wisselt toe, oude komen vrij, daemonfout draait terug", async () => {
    await admin.api.admin.servers.updateAllocations({ uuid, allocationIds: [allocC, allocB] });
    const put = h.daemon.last("PUT", `/api/servers/${uuid}`)!.body as DaemonServerSpec;
    expect(put.allocations).toEqual([{ ip: "127.0.0.1", port: 31002, primary: true }, { ip: "127.0.0.1", port: 31001, primary: false }]);
    const list = await admin.api.admin.allocations.list({ nodeId: h.localNodeId });
    expect(list.find((a) => a.id === allocA)).toMatchObject({ serverUuid: null, primary: false });
    expect(list.find((a) => a.id === allocC)).toMatchObject({ serverUuid: uuid, primary: true });
    expect(list.find((a) => a.id === allocB)).toMatchObject({ serverUuid: uuid, primary: false });

    h.daemon.mode = "error500";
    await expect(admin.api.admin.servers.updateAllocations({ uuid, allocationIds: [allocA] })).rejects.toThrow();
    h.daemon.mode = "ok";
    expect((await admin.api.admin.allocations.list({ nodeId: h.localNodeId })).find((a) => a.id === allocC)!.serverUuid).toBe(uuid);
    await expect(admin.api.admin.servers.updateAllocations({ uuid, allocationIds: [] })).rejects.toThrow(/ALLOCATION_REQUIRED/);
    await expect(admin.api.admin.allocations.delete({ id: allocC })).rejects.toThrow(/ALLOCATION_IN_USE/);
  });

  it("updateOwner: nieuwe eigenaar ziet de server, oude niet meer", async () => {
    const other = await h.user({ discordId: "220000000000000002", name: "nieuw" });
    await admin.api.admin.servers.updateOwner({ uuid, ownerId: other.id });
    expect((await other.api.servers.list()).map((s) => s.uuid)).toEqual([uuid]);
    expect(await player.api.servers.list()).toEqual([]);
    await expect(player.api.servers.get({ uuid })).rejects.toThrow(/NO_ACCESS/);
    await admin.api.admin.servers.updateOwner({ uuid, ownerId: player.id });
    await expect(admin.api.admin.servers.updateOwner({ uuid, ownerId: 9999 })).rejects.toThrow(/OWNER_NOT_FOUND/);
  });

  it("delete: daemon DELETE, allocations vrij, log blijft vindbaar op uuid", async () => {
    h.daemon.mode = "error500";
    await expect(admin.api.admin.servers.delete({ uuid })).rejects.toThrow();
    h.daemon.mode = "ok";
    await admin.api.admin.servers.delete({ uuid });
    expect(h.daemon.last("DELETE", `/api/servers/${uuid}`)).toBeTruthy();
    expect(h.daemon.servers.has(uuid)).toBe(false);
    expect((await admin.api.admin.allocations.list({ nodeId: h.localNodeId })).filter((a) => a.serverUuid === uuid)).toEqual([]);
    const log = await admin.api.admin.activity.search({ serverUuid: uuid });
    expect(log.items.map((i) => i.action)).toEqual(expect.arrayContaining(["admin.server.delete", "admin.server.create"]));
    expect(log.items.find((i) => i.action === "admin.server.delete")?.serverName).toBe("Test");
    await expect(admin.api.admin.servers.delete({ uuid })).rejects.toThrow(/SERVER_NOT_FOUND/);
  });

  it("delete: daemon kent de server niet (404) → toch weg uit het panel", async () => {
    await admin.api.admin.allocations.create({ nodeId: h.localNodeId, ip: "127.0.0.1", ports: "33000" });
    const a = (await admin.api.admin.allocations.list({ nodeId: h.localNodeId })).find((x) => x.port === 33000)!;
    const d = await admin.api.admin.servers.create({ name: "Weg", ownerId: player.id, nodeId: h.localNodeId, templateId: gameId, limits, allocationIds: [a.id], variables: {}, startOnInstall: false });
    h.daemon.servers.delete(d.uuid);
    await admin.api.admin.servers.delete({ uuid: d.uuid });
    expect(await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, d.uuid))).toEqual([]);
  });
});

describe("admin.templates", () => {
  it("list, get, validate", async () => {
    const list = await admin.api.admin.templates.list();
    expect(list.map((t) => t.slug).sort()).toEqual(["testgame", "testweb"]);
    expect(list.find((t) => t.slug === "testgame")).toMatchObject({ type: "game", version: 1, description: "Template voor tests" });
    const t = await admin.api.admin.templates.get({ id: gameId });
    expect(t.yaml).toBe(GAME_TEMPLATE);
    expect(t.variables[0]).toEqual({ key: "JAR_FILE", name: "JAR-bestand", description: null, default: "server.jar", userEditable: true, pattern: "^[A-Za-z0-9._-]+\\.jar$" });
    await expect(admin.api.admin.templates.get({ id: 9999 })).rejects.toThrow(/TEMPLATE_NOT_FOUND/);
    expect(await admin.api.admin.templates.validate({ yaml: GAME_TEMPLATE })).toEqual({ ok: true, errors: [] });
    const bad = await admin.api.admin.templates.validate({ yaml: "schema: 1\nslug: x" });
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
    expect((await admin.api.admin.templates.validate({ yaml: ": : :" })).ok).toBe(false);
  });
});

describe("admin.users", () => {
  it("create (vooraf op Discord-ID), list met zoeken, get", async () => {
    const u = await admin.api.admin.users.create({ discordId: "230000000000000001" });
    expect(u).toMatchObject({ name: null, blocked: false, isAdmin: false, serverCount: 0, lastLoginAt: null });
    await expect(admin.api.admin.users.create({ discordId: "230000000000000001" })).rejects.toThrow(/USER_EXISTS/);
    expect((await admin.api.admin.users.list({ search: "spel" })).items.map((x) => x.discordId)).toEqual([player.discordId]);
    expect((await admin.api.admin.users.list({ search: "2300" })).items.map((x) => x.id)).toEqual([u.id]);
    expect((await admin.api.admin.users.get({ id: u.id })).discordId).toBe("230000000000000001");
    const own = (await admin.api.admin.users.list({ search: "eigenaar" })).items[0]!;
    expect(own).toMatchObject({ isAdmin: true, totpEnabled: true });
    const p1 = await admin.api.admin.users.list({ limit: 2 });
    expect(p1.items).toHaveLength(2);
    const p2 = await admin.api.admin.users.list({ limit: 2, cursor: p1.nextCursor });
    expect(p2.items[0]!.id).toBeGreaterThan(p1.items[1]!.id);
    await expect(admin.api.admin.users.get({ id: 9999 })).rejects.toThrow(/USER_NOT_FOUND/);
  });

  it("setBlocked: sessies weg, login geweigerd; eigenaar en jezelf niet", async () => {
    const victim = await h.user({ discordId: "230000000000000002", name: "blok" });
    await admin.api.admin.users.setBlocked({ id: victim.id, blocked: true });
    expect(await (await h.refresh(victim)).api.auth.me()).toBeNull();
    expect((await admin.api.admin.users.get({ id: victim.id })).blocked).toBe(true);
    await admin.api.admin.users.setBlocked({ id: victim.id, blocked: false });
    await expect(admin.api.admin.users.setBlocked({ id: admin.id, blocked: true })).rejects.toThrow(/CANNOT_BLOCK_OWNER/);
    const actions = (await admin.api.admin.activity.search({ action: "admin.user" })).items.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(["admin.user.block", "admin.user.unblock", "admin.user.create"]));
  });

  it("resetTotp", async () => {
    const u = await h.user({ discordId: "230000000000000003", totp: true });
    await admin.api.admin.users.resetTotp({ id: u.id });
    expect((await admin.api.admin.users.get({ id: u.id })).totpEnabled).toBe(false);
  });
});

describe("admin.admins", () => {
  it("list, add, remove; eigenaar kan niet weg", async () => {
    await admin.api.admin.admins.add({ discordId: "240000000000000001" });
    await admin.api.admin.admins.add({ discordId: "240000000000000001" }); // idempotent
    const list = await admin.api.admin.admins.list();
    expect(list.find((a) => a.discordId === OWNER)).toMatchObject({ isOwner: true, user: { name: "eigenaar" }, addedBy: null });
    expect(list.find((a) => a.discordId === "240000000000000001")).toMatchObject({ isOwner: false, user: null, addedBy: { id: admin.id } });
    await expect(admin.api.admin.admins.remove({ discordId: OWNER })).rejects.toThrow(/CANNOT_REMOVE_OWNER/);
    await admin.api.admin.admins.remove({ discordId: "240000000000000001" });
    await expect(admin.api.admin.admins.remove({ discordId: "240000000000000001" })).rejects.toThrow(/ADMIN_NOT_FOUND/);
    expect((await admin.api.admin.activity.search({ action: "admin.admins" })).items.map((i) => i.action)).toEqual(["admin.admins.remove", "admin.admins.add"]);
  });
});

describe("admin.activity.search", () => {
  it("filtert op gebruiker en actie(prefix)", async () => {
    const byAdmin = await admin.api.admin.activity.search({ userId: admin.id, limit: 100 });
    expect(byAdmin.items.every((i) => i.user?.id === admin.id)).toBe(true);
    expect((await admin.api.admin.activity.search({ action: "admin" })).items.length).toBeGreaterThan(3);
    expect((await admin.api.admin.activity.search({ action: "admin.serv" })).items).toEqual([]);
  });
});
