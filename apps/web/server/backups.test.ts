import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as reportBackupRoute } from "@/app/api/remote/backups/[backup_id]/route";
import { POST as reportRestoreRoute } from "@/app/api/remote/backups/[backup_id]/restore/route";
import { getDb, schema } from "./db";
import { decrypt } from "./lib/crypto";
import { nextRuns } from "./lib/cron";
import { setSetting } from "./test/settings";
import { tick } from "./scheduler";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, owner: TestUser, creator: TestUser, restorer: TestUser, scheduler: TestUser, stranger: TestUser;
let uuid = "";
let targetId = 0;

/** Minimale S3 (path-style): PUT/DELETE per object, controleert de access key in de handtekening. */
const objects = new Map<string, number>();
let s3: Server;
let s3Url = "";
let s3Down = false;

beforeAll(async () => {
  s3 = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const key = decodeURIComponent((req.url ?? "").split("?")[0]!);
      if (s3Down) return res.writeHead(503).end();
      if (!(req.headers.authorization ?? "").includes("Credential=AKTESTKEY/")) {
        return res.writeHead(403, { "content-type": "application/xml" }).end("<Error><Code>InvalidAccessKeyId</Code><Message>bad key</Message></Error>");
      }
      if (req.method === "PUT") {
        objects.set(key, Buffer.concat(chunks).length);
        return res.writeHead(200, { etag: '"abc"' }).end();
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return res.writeHead(204).end();
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => s3.listen(0, "127.0.0.1", () => r()));
  s3Url = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;

  admin = await h.user({ discordId: OWNER, admin: true, totp: true });
  owner = await h.user({ discordId: "280000000000000001", name: "eigenaar" });
  creator = await h.user({ discordId: "280000000000000002", name: "maker" });
  restorer = await h.user({ discordId: "280000000000000003", name: "herstel" });
  scheduler = await h.user({ discordId: "280000000000000004", name: "planner" });
  stranger = await h.user({ discordId: "280000000000000005", name: "vreemde" });
  const d = await admin.api.admin.servers.create({
    name: "Back",
    ownerId: owner.id,
    nodeId: h.localNodeId,
    templateId: await h.templateId("testweb"),
    limits: { cpuPct: 100, ramMb: 256, swapMb: 0, diskMb: 1024 },
    allocationIds: [],
    variables: {},
    startOnInstall: true,
  });
  uuid = d.uuid;
  await owner.api.subusers.invite({ uuid, who: creator.discordId, permissions: ["backup.create"] });
  await owner.api.subusers.invite({ uuid, who: restorer.discordId, permissions: ["backup.restore"] });
  await owner.api.subusers.invite({ uuid, who: scheduler.discordId, permissions: ["schedule.manage"] });
}, 180_000);

afterAll(async () => {
  s3?.closeAllConnections();
  s3?.close();
});

const req = (path: string, body: unknown, token = h.env.NODE_TOKEN!) =>
  new Request(`http://panel.test${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const lastBackup = async (id: number) => (await getDb().select().from(schema.backups).where(eq(schema.backups.id, id)))[0]!;
const SHA = "a".repeat(64);

describe("admin.s3Targets.*", () => {
  it("alleen admin; sleutels versleuteld; alleen de eerste 4 tekens terug", async () => {
    await expect(owner.api.admin.s3Targets.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const t = await admin.api.admin.s3Targets.create({ name: "Unraid", endpoint: `${s3Url}/`, bucket: "panel-backups", region: "us-east-1", pathStyle: true, accessKey: "AKTESTKEY", secretKey: "supersecretvalue" });
    targetId = t.id;
    expect(t).toMatchObject({ name: "Unraid", endpoint: s3Url, accessKeyPreview: "AKTE", pathStyle: true });
    expect(JSON.stringify(t)).not.toContain("supersecret");
    const [row] = await getDb().select().from(schema.s3Targets).where(eq(schema.s3Targets.id, t.id));
    expect(row!.secretKeyEnc).not.toContain("supersecret");
    expect(decrypt(row!.secretKeyEnc)).toBe("supersecretvalue");
    expect(await admin.api.admin.s3Targets.list()).toHaveLength(1);
  });

  it("test doet een echte put en delete; foute sleutel of onbereikbaar geeft een fout", async () => {
    objects.clear();
    expect(await admin.api.admin.s3Targets.test({ id: targetId })).toEqual({ ok: true, error: null });
    expect(objects.size).toBe(0); // opgeruimd
    const bad = await admin.api.admin.s3Targets.update({ id: targetId, accessKey: "WRONGKEY" });
    expect(bad.accessKeyPreview).toBe("WRON");
    const r = await admin.api.admin.s3Targets.test({ id: targetId });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/InvalidAccessKeyId|bad key/);
    await admin.api.admin.s3Targets.update({ id: targetId, accessKey: "AKTESTKEY" });
    s3Down = true;
    expect((await admin.api.admin.s3Targets.test({ id: targetId })).ok).toBe(false);
    s3Down = false;
  });

  it("standaarddoel per node", async () => {
    const n = (await admin.api.admin.nodes.list()).find((x) => x.isLocal)!;
    const upd = await admin.api.admin.nodes.update({ id: n.id, name: n.name, fqdn: n.fqdn, daemonPort: n.daemonPort, sftpPort: n.sftpPort, maxRamMb: n.maxRamMb, maxDiskMb: n.maxDiskMb, s3TargetId: targetId });
    expect(upd.s3TargetId).toBe(targetId);
  });
});

describe("backups.*", () => {
  let id = 0;

  it("create: rechten, daemonverzoek met credentials en sleutel, status running", async () => {
    await expect(restorer.api.backups.create({ uuid, name: null, includeDatabases: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(stranger.api.backups.create({ uuid, name: null, includeDatabases: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.daemon.override = (r) => (r.method === "POST" && r.path.endsWith("/backups") ? { status: 202 } : undefined);
    const b = await creator.api.backups.create({ uuid, name: "Voor update", includeDatabases: true });
    id = b.id;
    expect(b).toMatchObject({ name: "Voor update", status: "running", serverUuid: uuid, sha256: null });
    const sent = h.daemon.last("POST", `/api/servers/${uuid}/backups`)!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ backup_id: id, key: `servers/${uuid}/${id}.tar.zst`, databases: [], s3: { endpoint: s3Url, bucket: "panel-backups", access_key: "AKTESTKEY", secret_key: "supersecretvalue", path_style: true } });
    const [row] = await getDb().select().from(schema.backups).where(eq(schema.backups.id, id));
    expect(row!.s3Key).toBe(`servers/${uuid}/${id}.tar.zst`);
  });

  it("daemon weigert (409) of is onbereikbaar: rij wordt failed, fout komt door", async () => {
    h.daemon.override = () => ({ status: 409, body: { error: "conflict", message: "busy" } });
    await expect(creator.api.backups.create({ uuid, name: "x", includeDatabases: false })).rejects.toMatchObject({ code: "CONFLICT" });
    h.daemon.mode = "error500";
    await expect(creator.api.backups.create({ uuid, name: "y", includeDatabases: false })).rejects.toBeTruthy();
    h.daemon.mode = "ok";
    const list = await creator.api.backups.list({ uuid });
    expect(list.filter((b) => b.status === "failed")).toHaveLength(2);
    h.daemon.override = (r) => (r.method === "POST" && r.path.includes("/backups") ? { status: 202 } : undefined);
  });

  it("zonder S3-doel: PRECONDITION_FAILED (NO_S3_TARGET)", async () => {
    const n = (await admin.api.admin.nodes.list()).find((x) => x.isLocal)!;
    const second = await admin.api.admin.s3Targets.create({ name: "Tweede", endpoint: s3Url, bucket: "b2", region: "us-east-1", pathStyle: true, accessKey: "AKTESTKEY", secretKey: "s2s2s2s2" });
    await admin.api.admin.nodes.update({ id: n.id, name: n.name, fqdn: n.fqdn, daemonPort: n.daemonPort, sftpPort: n.sftpPort, maxRamMb: n.maxRamMb, maxDiskMb: n.maxDiskMb, s3TargetId: null });
    await expect(creator.api.backups.create({ uuid, name: null, includeDatabases: false })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "NO_S3_TARGET" });
    await admin.api.admin.s3Targets.delete({ id: second.id });
    // Met één doel valt hij daar automatisch op terug; herstel het standaarddoel.
    await admin.api.admin.nodes.update({ id: n.id, name: n.name, fqdn: n.fqdn, daemonPort: n.daemonPort, sftpPort: n.sftpPort, maxRamMb: n.maxRamMb, maxDiskMb: n.maxDiskMb, s3TargetId: targetId });
  });

  it("remote-rapport: completed met checksum en grootte; verkeerd token 401; vreemde node 404", async () => {
    expect((await reportBackupRoute(req(`/api/remote/backups/${id}`, { successful: true, sha256: SHA, size_bytes: 1234 }, "fout"), params({ backup_id: String(id) }))).status).toBe(401);
    expect((await reportBackupRoute(req(`/api/remote/backups/${id}`, { successful: true }), params({ backup_id: String(id) }))).status).toBe(400);
    expect((await reportBackupRoute(req(`/api/remote/backups/999999`, { successful: true, sha256: SHA, size_bytes: 1 }), params({ backup_id: "999999" }))).status).toBe(404);
    expect((await reportBackupRoute(req(`/api/remote/backups/${id}`, { successful: true, sha256: SHA, size_bytes: 1234 }), params({ backup_id: String(id) }))).status).toBe(204);
    const b = await lastBackup(id);
    expect(b).toMatchObject({ status: "completed", sha256: SHA, sizeBytes: 1234 });
    expect(b.completedAt).toBeInstanceOf(Date);
  });

  it("list: maker en herstel zien hem; vreemde en schema-beheerder niet", async () => {
    expect((await creator.api.backups.list({ uuid })).some((b) => b.id === id)).toBe(true);
    expect((await restorer.api.backups.list({ uuid })).some((b) => b.id === id)).toBe(true);
    await expect(scheduler.api.backups.list({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(stranger.api.backups.list({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("downloadUrl: gesigneerde S3-url (10 min); alleen met backup.restore", async () => {
    await expect(creator.api.backups.downloadUrl({ id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const u = await restorer.api.backups.downloadUrl({ id });
    const url = new URL(u.url);
    expect(url.origin).toBe(s3Url);
    expect(url.pathname).toBe(`/panel-backups/servers/${uuid}/${id}.tar.zst`);
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("AKTESTKEY/");
    expect(url.search).not.toContain("supersecret");
    expect(u.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it("restore: backup.restore nodig; daemonverzoek met sha256; status restoring → completed via rapport", async () => {
    await expect(creator.api.backups.restore({ id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(stranger.api.backups.restore({ id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await restorer.api.backups.restore({ id })).toEqual({ ok: true });
    const sent = h.daemon.last("POST", `/api/servers/${uuid}/backups/${id}/restore`)!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ key: `servers/${uuid}/${id}.tar.zst`, sha256: SHA, databases: [] });
    expect((await lastBackup(id)).status).toBe("restoring");
    await expect(owner.api.backups.delete({ id })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await reportRestoreRoute(req(`/api/remote/backups/${id}/restore`, { successful: false, error: "checksum mismatch" }), params({ backup_id: String(id) }))).status).toBe(204);
    expect(await lastBackup(id)).toMatchObject({ status: "completed", error: "checksum mismatch" });
  });

  it("restore van een niet-voltooide backup of met onbereikbare daemon: CONFLICT / status teruggezet", async () => {
    const pending = (await getDb().select().from(schema.backups).where(eq(schema.backups.status, "failed")))[0]!;
    await expect(owner.api.backups.restore({ id: pending.id })).rejects.toMatchObject({ code: "CONFLICT" });
    h.daemon.override = () => ({ status: 409, body: { error: "conflict", message: "busy" } });
    await expect(owner.api.backups.restore({ id })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await lastBackup(id)).status).toBe("completed");
    h.daemon.override = (r) => (r.method === "POST" && r.path.includes("/backups") ? { status: 202 } : undefined);
  });

  it("maximum per server: de oudste gaat uit S3 en de database", async () => {
    await setSetting("max_backups_per_server", 3);
    const key = (n: number) => `/panel-backups/servers/${uuid}/${n}.tar.zst`;
    const ids = [id];
    objects.set(key(id), 5);
    for (let i = 0; i < 3; i++) {
      const b = await owner.api.backups.create({ uuid, name: `n${i}`, includeDatabases: false });
      ids.push(b.id);
      objects.set(key(b.id), 5);
      await reportBackupRoute(req(`/api/remote/backups/${b.id}`, { successful: true, sha256: SHA, size_bytes: 5 }), params({ backup_id: String(b.id) }));
    }
    const left = (await owner.api.backups.list({ uuid })).filter((b) => b.status === "completed").map((b) => b.id);
    expect(left).toHaveLength(3);
    expect(left).not.toContain(id);
    expect(objects.has(key(id))).toBe(false);
    expect(objects.has(key(ids[3]!))).toBe(true);
    id = ids[3]!;
  });

  it("delete: backup.create; verwijdert het S3-object; S3-fout laat de rij staan", async () => {
    await expect(restorer.api.backups.delete({ id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    s3Down = true;
    await expect(creator.api.backups.delete({ id })).rejects.toMatchObject({ message: expect.stringContaining("S3_ERROR") });
    s3Down = false;
    expect(await lastBackup(id)).toBeTruthy();
    expect(await creator.api.backups.delete({ id })).toEqual({ ok: true });
    expect(objects.has(`/panel-backups/servers/${uuid}/${id}.tar.zst`)).toBe(false);
    const rows = await getDb().select().from(schema.backups).where(eq(schema.backups.id, id));
    expect(rows).toHaveLength(0);
  });

  it("mislukte backup via rapport; S3-doel in gebruik kan niet weg", async () => {
    h.daemon.override = (r) => (r.method === "POST" && r.path.includes("/backups") ? { status: 202 } : undefined);
    const b = await owner.api.backups.create({ uuid, name: "faalt", includeDatabases: false });
    await reportBackupRoute(req(`/api/remote/backups/${b.id}`, { successful: false, error: "upload: connection refused" }), params({ backup_id: String(b.id) }));
    expect(await lastBackup(b.id)).toMatchObject({ status: "failed", error: "upload: connection refused" });
    await expect(admin.api.admin.s3Targets.delete({ id: targetId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("progress en cancel: alleen met lopende backup; daemonfouten vertaald; geannuleerd rapport zonder melding", async () => {
    h.daemon.override = (r) => (r.method === "POST" && r.path.endsWith("/backups") ? { status: 202 } : undefined);
    // Niets actief: geen daemonverzoek.
    for (const b of await owner.api.backups.list({ uuid })) if (b.status === "running" || b.status === "pending") await getDb().update(schema.backups).set({ status: "failed" }).where(eq(schema.backups.id, b.id));
    h.daemon.requests.length = 0;
    expect(await creator.api.backups.progress({ uuid })).toBeNull();
    expect(h.daemon.requests.some((r) => r.path.endsWith("/backups/progress"))).toBe(false);
    await expect(stranger.api.backups.progress({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const b = await creator.api.backups.create({ uuid, name: "lang", includeDatabases: false });
    const live = { backup_id: b.id, operation: "backup", phase: "archiving", bytes: 50, total_bytes: 200, percent: 24, eta_seconds: 9, started_at: "2026-11-27T10:00:00Z", cancellable: true };
    let cancelReply: { status: number; body?: unknown } = { status: 202 };
    h.daemon.override = (r) => {
      if (r.method === "GET" && r.path === `/api/servers/${uuid}/backups/progress`) return { status: 200, body: { progress: live } };
      if (r.method === "POST" && r.path === `/api/servers/${uuid}/backups/${b.id}/cancel`) return cancelReply;
      return undefined;
    };
    expect(await restorer.api.backups.progress({ uuid })).toEqual({ backupId: b.id, operation: "backup", phase: "archiving", bytes: 50, totalBytes: 200, percent: 24, etaSeconds: 9, startedAt: new Date("2026-11-27T10:00:00Z"), cancellable: true });

    // Annuleren van een backup vraagt backup.create.
    await expect(restorer.api.backups.cancel({ id: b.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(stranger.api.backups.cancel({ id: b.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    cancelReply = { status: 409, body: { error: "not_cancellable", message: "too late" } };
    await expect(creator.api.backups.cancel({ id: b.id })).rejects.toMatchObject({ code: "CONFLICT", message: "BACKUP_NOT_CANCELLABLE" });
    cancelReply = { status: 404, body: { error: "not_running", message: "nothing" } };
    await expect(creator.api.backups.cancel({ id: b.id })).rejects.toMatchObject({ code: "CONFLICT", message: "BACKUP_NOT_RUNNING" });
    cancelReply = { status: 202 };
    expect(await creator.api.backups.cancel({ id: b.id })).toEqual({ ok: true });
    expect(h.daemon.last("POST", `/api/servers/${uuid}/backups/${b.id}/cancel`)).toBeTruthy();

    // Daemon onbereikbaar of kapot: progress is null (de UI valt terug op "bezig").
    h.daemon.override = () => ({ status: 500, body: { error: "internal", message: "kapot" } });
    expect(await creator.api.backups.progress({ uuid })).toBeNull();

    // Het rapport van de daemon: failed met "cancelled", eigen activiteit.
    expect((await reportBackupRoute(req(`/api/remote/backups/${b.id}`, { successful: false, error: "cancelled" }), params({ backup_id: String(b.id) }))).status).toBe(204);
    expect(await lastBackup(b.id)).toMatchObject({ status: "failed", error: "cancelled" });
    const acts = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.serverId, (await lastBackup(b.id)).serverId));
    expect(acts.map((a) => a.action)).toEqual(expect.arrayContaining(["server.backup.cancel", "server.backup.cancelled"]));
    await expect(creator.api.backups.cancel({ id: b.id })).rejects.toMatchObject({ code: "CONFLICT", message: "BACKUP_NOT_RUNNING" });
    h.daemon.override = (r) => (r.method === "POST" && r.path.includes("/backups") ? { status: 202 } : undefined);
  });
});

describe("schedules.*", () => {
  let sid = 0;
  const input = { name: "Dagelijkse herstart", cron: "0 4 * * *", action: "restart" as const, payload: null, active: true };

  it("cron in Europe/Amsterdam (zomer- en wintertijd)", () => {
    expect(nextRuns("0 4 * * *", 1, new Date("2026-11-27T12:00:00Z"))[0]!.toISOString()).toBe("2026-11-28T03:00:00.000Z");
    expect(nextRuns("0 4 * * *", 1, new Date("2026-07-01T12:00:00Z"))[0]!.toISOString()).toBe("2026-07-02T02:00:00.000Z");
  });

  it("create/list/update/delete met schedule.manage; anderen FORBIDDEN", async () => {
    await expect(creator.api.schedules.create({ uuid, ...input })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(stranger.api.schedules.list({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(scheduler.api.schedules.create({ uuid, ...input, cron: "nonsense" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(scheduler.api.schedules.create({ uuid, ...input, cron: "0 0 4 * * *" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(scheduler.api.schedules.create({ uuid, ...input, action: "command", payload: null })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const s = await scheduler.api.schedules.create({ uuid, ...input });
    sid = s.id;
    expect(s).toMatchObject({ name: input.name, cron: "0 4 * * *", active: true, lastRunAt: null, lastResult: null });
    expect(s.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    const u = await scheduler.api.schedules.update({ id: sid, ...input, active: false });
    expect(u).toMatchObject({ active: false, nextRunAt: null });
    expect((await owner.api.schedules.list({ uuid })).map((x) => x.id)).toContain(sid);
    await expect(creator.api.schedules.update({ id: sid, ...input })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(creator.api.schedules.delete({ id: sid })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("runNow: restart, command en backup; last_run en last_result worden gezet", async () => {
    h.daemon.override = (r) => (r.method === "POST" && /\/(power|commands|backups)$/.test(r.path) ? { status: r.path.endsWith("/commands") ? 204 : 202 } : undefined);
    await scheduler.api.schedules.update({ id: sid, ...input, active: true });
    await scheduler.api.schedules.runNow({ id: sid });
    expect(h.daemon.last("POST", `/api/servers/${uuid}/power`)!.body).toEqual({ action: "restart" });
    let s = (await scheduler.api.schedules.list({ uuid })).find((x) => x.id === sid)!;
    expect(s.lastResult).toBe("ok");
    expect(s.lastRunAt).toBeInstanceOf(Date);

    const c = await scheduler.api.schedules.create({ uuid, name: "Save", cron: "*/5 * * * *", action: "command", payload: "save-all", active: true });
    await scheduler.api.schedules.runNow({ id: c.id });
    expect(h.daemon.last("POST", `/api/servers/${uuid}/commands`)!.body).toEqual({ commands: ["save-all"] });

    const before = (await getDb().select().from(schema.backups).where(eq(schema.backups.serverId, (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid)))[0]!.id))).length;
    const bk = await scheduler.api.schedules.create({ uuid, name: "Nachtbackup", cron: "0 4 * * *", action: "backup", payload: null, active: true });
    await scheduler.api.schedules.runNow({ id: bk.id });
    const after = await getDb().select().from(schema.backups);
    expect(after.filter((b) => b.name.startsWith("Nachtbackup")).length).toBe(1);
    expect(after.length).toBeGreaterThan(before);

    h.daemon.override = () => ({ status: 409, body: { error: "conflict", message: "busy" } });
    await expect(scheduler.api.schedules.runNow({ id: sid })).rejects.toBeTruthy();
    s = (await scheduler.api.schedules.list({ uuid })).find((x) => x.id === sid)!;
    expect(s.lastResult).toMatch(/^error: /);
    for (const x of [c.id, bk.id]) await scheduler.api.schedules.delete({ id: x });
  });

  it("scheduler-tik: vervallen schema draait één keer en plant de volgende; inactief niet", async () => {
    h.daemon.override = (r) => (r.method === "POST" && /\/power$/.test(r.path) ? { status: 202 } : undefined);
    const db = getDb();
    await db.update(schema.schedules).set({ nextRunAt: new Date(Date.now() - 60_000), lastRunAt: null, lastResult: null }).where(eq(schema.schedules.id, sid));
    const calls = () => h.daemon.requests.filter((r) => r.path.endsWith("/power")).length;
    const c0 = calls();
    expect(await tick()).toBeGreaterThanOrEqual(1);
    expect(calls()).toBe(c0 + 1);
    const [row] = await db.select().from(schema.schedules).where(eq(schema.schedules.id, sid));
    expect(row!.lastResult).toBe("ok");
    expect(row!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    // Tweede tik meteen erna: niets meer te doen (en twee gelijktijdige tikken draaien niet dubbel).
    await db.update(schema.schedules).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schema.schedules.id, sid));
    const c1 = calls();
    await Promise.all([tick(), tick()]);
    expect(calls()).toBe(c1 + 1);
    await db.update(schema.schedules).set({ active: false, nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schema.schedules.id, sid));
    const c2 = calls();
    await tick();
    expect(calls()).toBe(c2);
    expect(await scheduler.api.schedules.delete({ id: sid })).toEqual({ ok: true });
  });
});
