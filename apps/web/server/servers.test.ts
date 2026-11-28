import type { DaemonServerSpec } from "@panel/api";
import { ALL_PERMISSIONS } from "@panel/api";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { getSigningKey, verifyJwt } from "./lib/jwt";
import { pollAllNow } from "./node-cache";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser, sub: TestUser, stranger: TestUser, subNone: TestUser;
let uuid = "";

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "210000000000000001", name: "Speler" });
  sub = await h.user({ discordId: "210000000000000002", name: "sub" });
  subNone = await h.user({ discordId: "210000000000000003", name: "subzonder" });
  stranger = await h.user({ discordId: "210000000000000004", name: "vreemd" });
  const alloc = await h.allocation(25565);
  const created = await admin.api.admin.servers.create({
    name: "SMP",
    ownerId: player.id,
    nodeId: h.localNodeId,
    templateId: await h.templateId("testgame"),
    limits: { cpuPct: 200, ramMb: 1024, swapMb: 0, diskMb: 2048 },
    allocationIds: [alloc],
    variables: {},
    startOnInstall: true,
  });
  uuid = created.uuid;
  const [srv] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid));
  await getDb().insert(schema.subusers).values([
    { serverId: srv!.id, userId: sub.id, permissions: ["console.read"] },
    { serverId: srv!.id, userId: subNone.id, permissions: [] },
  ]);
});

const setState = (state: "online" | "offline" | "installing") => {
  h.daemon.servers.get(uuid)!.state = state;
};

describe("servers.list / get", () => {
  it("eigenaar en subusers zien de server, vreemden niet; admins zien hier alleen eigen servers", async () => {
    expect((await player.api.servers.list()).map((s) => s.uuid)).toEqual([uuid]);
    expect((await sub.api.servers.list()).map((s) => s.uuid)).toEqual([uuid]);
    expect(await stranger.api.servers.list()).toEqual([]);
    expect(await admin.api.servers.list()).toEqual([]);
    const [s] = await player.api.servers.list();
    expect(s).toMatchObject({ name: "SMP", isOwner: true, primaryAddress: "127.0.0.1:25565", templateName: "Testspel", shortId: uuid.slice(0, 8) });
    expect((await sub.api.servers.list())[0]!.isOwner).toBe(false);
  });

  it("all: true geeft een volledige admin alle servers in de gebruikersweergave; anderen FORBIDDEN", async () => {
    const all = await admin.api.servers.list({ all: true });
    expect(all.map((s) => s.uuid)).toContain(uuid);
    expect(all.find((s) => s.uuid === uuid)).toMatchObject({ isOwner: false, owner: expect.objectContaining({ name: "Speler" }) });
    for (const u of [player, sub, stranger]) {
      await expect(u.api.servers.list({ all: true })).rejects.toMatchObject({ code: "FORBIDDEN", message: "NOT_ADMIN" });
    }
    expect((await player.api.servers.list({ all: false })).map((s) => s.uuid)).toEqual([uuid]);
  });

  it("get: live status van de daemon en terugschrijven naar de database", async () => {
    setState("online");
    await pollAllNow();
    const d = await player.api.servers.get({ uuid });
    expect(d.status).toBe("online");
    expect(d.permissions).toHaveLength(ALL_PERMISSIONS.length);
    expect(d.sftp).toEqual({ host: "node1.test", port: 2222, username: `speler.${uuid.slice(0, 8)}` });
    expect(d.variables.find((v) => v.key === "JAR_FILE")).toMatchObject({ value: "server.jar", userEditable: true });
    const [row] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid));
    expect(row!.status).toBe("online");
  });

  it("get/list: daemon hangt -> laatste bekende status, pas na de drempel `unknown`; nooit wachten op de daemon", async () => {
    process.env.NODE_POLL_TIMEOUT_MS = "150";
    process.env.NODE_STALE_AFTER_MS = "2000";
    try {
      setState("online");
      await pollAllNow();
      h.daemon.mode = "hang";
      await pollAllNow(); // mislukt na 150 ms; de cache blijft
      const t = Date.now();
      expect((await player.api.servers.get({ uuid })).status).toBe("online");
      expect((await player.api.servers.list())[0]!.status).toBe("online");
      expect(Date.now() - t).toBeLessThan(500);
      await new Promise((r) => setTimeout(r, 2100));
      const t2 = Date.now();
      const d = await player.api.servers.get({ uuid });
      expect(d.status).toBe("unknown");
      expect(d.lastSeenAt).toBeInstanceOf(Date);
      expect((await player.api.servers.list())[0]!.status).toBe("unknown");
      expect(Date.now() - t2).toBeLessThan(500);
      const [row] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid));
      expect(row!.status).toBe("online");
    } finally {
      h.daemon.mode = "ok";
      delete process.env.NODE_POLL_TIMEOUT_MS;
      delete process.env.NODE_STALE_AFTER_MS;
      await pollAllNow();
    }
  });

  it("get: subuser krijgt zijn eigen rechten; vreemde FORBIDDEN; onbekend NOT_FOUND", async () => {
    expect((await sub.api.servers.get({ uuid })).permissions).toEqual(["console.read"]);
    await expect(stranger.api.servers.get({ uuid })).rejects.toThrow(/FORBIDDEN|NO_ACCESS/);
    await expect(player.api.servers.get({ uuid: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/SERVER_NOT_FOUND/);
  });

  it("admin (met 2FA) mag elke server bekijken", async () => {
    expect((await admin.api.servers.get({ uuid })).isOwner).toBe(false);
  });
});

describe("servers.stats / power / sendCommand / consoleToken", () => {
  it("stats vereist console.read", async () => {
    const s = await sub.api.servers.stats({ uuid });
    expect(s).toMatchObject({ memoryLimitBytes: 1024 * 1024 * 1024, cpuPct: 12.5 });
    await expect(subNone.api.servers.stats({ uuid })).rejects.toThrow(/MISSING_PERMISSION: console.read/);
    await expect(stranger.api.servers.stats({ uuid })).rejects.toThrow(/NO_ACCESS/);
  });

  it("stats: daemon kent server niet → null; daemon onbereikbaar → DAEMON_UNREACHABLE", async () => {
    h.daemon.override = (r) => (r.path.endsWith("/stats") ? { status: 404, body: { error: "not_found" } } : undefined);
    expect(await player.api.servers.stats({ uuid })).toBeNull();
    h.daemon.override = null;
    h.daemon.mode = "error500";
    await expect(player.api.servers.stats({ uuid })).rejects.toThrow(/DAEMON_INTERNAL/);
    h.daemon.mode = "ok";
  });

  it("power: eigenaar mag, gelogd als server.power.<actie>; subuser zonder power FORBIDDEN", async () => {
    setState("offline");
    await player.api.servers.power({ uuid, action: "start" });
    expect(h.daemon.last("POST", `/api/servers/${uuid}/power`)?.body).toEqual({ action: "start" });
    await expect(sub.api.servers.power({ uuid, action: "stop" })).rejects.toThrow(/MISSING_PERMISSION: power/);
    await expect(stranger.api.servers.power({ uuid, action: "kill" })).rejects.toThrow(/NO_ACCESS/);
    const log = await player.api.servers.activity({ uuid });
    expect(log.items[0]).toMatchObject({ action: "server.power.start", serverUuid: uuid, serverName: "SMP" });
    expect(log.items[0]!.user?.discordId).toBe(player.discordId);
  });

  it("power: daemon 409 → CONFLICT", async () => {
    setState("installing");
    await expect(player.api.servers.power({ uuid, action: "start" })).rejects.toThrow(/DAEMON_INVALID_STATE/);
    setState("online");
  });

  it("sendCommand vereist console.write", async () => {
    setState("online");
    await player.api.servers.sendCommand({ uuid, command: "say hallo" });
    expect(h.daemon.last("POST", `/api/servers/${uuid}/commands`)?.body).toEqual({ commands: ["say hallo"] });
    await expect(sub.api.servers.sendCommand({ uuid, command: "op mij" })).rejects.toThrow(/MISSING_PERMISSION: console.write/);
  });

  it("consoleToken: EdDSA-JWT, 10 min, claims volgens openapi.yaml, rechten van de gebruiker", async () => {
    const t = await sub.api.servers.consoleToken({ uuid });
    expect(t.socketUrl).toBe(`wss://node1.test/api/servers/${uuid}/ws`);
    const key = await getSigningKey();
    const v = verifyJwt(t.token, key.publicKey)!;
    expect(v.header).toMatchObject({ alg: "EdDSA", typ: "JWT", kid: key.kid });
    expect(v.claims).toMatchObject({ iss: "http://127.0.0.1:3999", aud: "node1.test", sub: String(sub.id), server_uuid: uuid, permissions: ["console.read"] });
    expect(v.claims.exp - v.claims.iat).toBe(600);
    expect(t.expiresAt.getTime()).toBe(v.claims.exp * 1000);
    expect(v.claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect((verifyJwt((await player.api.servers.consoleToken({ uuid })).token, key.publicKey))!.claims.permissions).toHaveLength(ALL_PERMISSIONS.length);
    await expect(subNone.api.servers.consoleToken({ uuid })).rejects.toThrow(/MISSING_PERMISSION/);
    await expect(stranger.api.servers.consoleToken({ uuid })).rejects.toThrow(/NO_ACCESS/);
  });

  it("DAEMON_UNREACHABLE als de node niet antwoordt", async () => {
    await h.daemon.stop();
    try {
      await expect(player.api.servers.power({ uuid, action: "stop" })).rejects.toThrow(/DAEMON_UNREACHABLE/);
    } finally {
      const port = Number(new URL(h.env.DAEMON_URL!).port);
      await new Promise<void>((r) => (h.daemon as unknown as { server: import("node:http").Server }).server.listen(port, "127.0.0.1", () => r()));
    }
  });
});

describe("eigenaarsacties: rename / updateVariables / reinstall", () => {
  it("rename: alleen eigenaar (of admin)", async () => {
    await player.api.servers.rename({ uuid, name: "  Nieuwe naam " });
    expect((await player.api.servers.get({ uuid })).name).toBe("Nieuwe naam");
    await expect(sub.api.servers.rename({ uuid, name: "x" })).rejects.toThrow(/OWNER_ONLY/);
    await expect(stranger.api.servers.rename({ uuid, name: "x" })).rejects.toThrow(/NO_ACCESS/);
    await admin.api.servers.rename({ uuid, name: "SMP" });
  });

  it("updateVariables: alleen userEditable, patroon gecontroleerd, spec naar de daemon (skip_install)", async () => {
    await expect(player.api.servers.updateVariables({ uuid, variables: { SECRET_FLAG: "on" } })).rejects.toThrow(/cannot be changed by the user/);
    await expect(player.api.servers.updateVariables({ uuid, variables: { JAR_FILE: "kwaad; rm -rf" } })).rejects.toThrow(/does not match/);
    await expect(player.api.servers.updateVariables({ uuid, variables: { ONBEKEND: "1" } })).rejects.toThrow(/unknown variable/);
    await expect(sub.api.servers.updateVariables({ uuid, variables: { JAR_FILE: "a.jar" } })).rejects.toThrow(/OWNER_ONLY/);
    await player.api.servers.updateVariables({ uuid, variables: { JAR_FILE: "paper.jar" } });
    const put = h.daemon.last("PUT", `/api/servers/${uuid}`)!.body as DaemonServerSpec;
    expect(put.environment).toEqual({ JAR_FILE: "paper.jar", SECRET_FLAG: "off" });
    expect(put.skip_install).toBe(true);
    expect((await player.api.servers.get({ uuid })).variables.find((v) => v.key === "JAR_FILE")?.value).toBe("paper.jar");
    await player.api.servers.updateVariables({ uuid, variables: { JAR_FILE: "server.jar" } });
    expect((await player.api.servers.get({ uuid })).variables.find((v) => v.key === "JAR_FILE")?.value).toBe("server.jar");
  });

  it("updateVariables: daemon onbereikbaar → database ongewijzigd", async () => {
    h.daemon.mode = "error500";
    await expect(player.api.servers.updateVariables({ uuid, variables: { JAR_FILE: "x.jar" } })).rejects.toThrow();
    h.daemon.mode = "ok";
    expect((await player.api.servers.get({ uuid })).variables.find((v) => v.key === "JAR_FILE")?.value).toBe("server.jar");
  });

  it("reinstall: alleen eigenaar, status installing", async () => {
    setState("offline");
    await expect(sub.api.servers.reinstall({ uuid })).rejects.toThrow(/OWNER_ONLY/);
    await player.api.servers.reinstall({ uuid });
    expect(h.daemon.last("POST", `/api/servers/${uuid}/install`)).toBeTruthy();
    const [row] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid));
    expect(row!.status).toBe("installing");
  });
});

describe("servers.activity", () => {
  it("pagineert nieuwste eerst; subuser mag lezen, vreemde niet", async () => {
    const p1 = await player.api.servers.activity({ uuid, limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await player.api.servers.activity({ uuid, limit: 2, cursor: p1.nextCursor });
    expect(p2.items[0]!.id).toBeLessThan(p1.items[1]!.id);
    expect((await sub.api.servers.activity({ uuid })).items.length).toBeGreaterThan(0);
    await expect(stranger.api.servers.activity({ uuid })).rejects.toThrow(/NO_ACCESS/);
    const all = (await player.api.servers.activity({ uuid, limit: 100 })).items.map((i) => i.action);
    expect(all).toEqual(expect.arrayContaining(["admin.server.create", "server.rename", "server.variables.update", "server.reinstall", "server.console.command"]));
  });
});
