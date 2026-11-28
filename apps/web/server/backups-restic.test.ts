import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as reportBackupRoute } from "@/app/api/remote/backups/[backup_id]/route";
import { POST as reportRestoreRoute } from "@/app/api/remote/backups/[backup_id]/restore/route";
import { getDb, schema } from "./db";
import { decrypt } from "./lib/crypto";
import { tick } from "./scheduler";
import { cleanPath, restoreDirName } from "./backups-restic";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, owner: TestUser, creator: TestUser, restorer: TestUser, scheduler: TestUser, stranger: TestUser;
let uuid = "";
let serverId = 0;

const req = (path: string, body: unknown, token = h.env.NODE_TOKEN!) =>
  new Request(`http://panel.test${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const row = async (id: number) => (await getDb().select().from(schema.backups).where(eq(schema.backups.id, id)))[0];
const snap = (c: string) => c.repeat(64);
const report = (id: number, body: unknown) => reportBackupRoute(req(`/api/remote/backups/${id}`, body), params({ backup_id: String(id) }));
const accept = () => {
  h.daemon.override = (r) => {
    if (r.method === "POST" && (r.path.endsWith("/restic/backups") || r.path.endsWith("/restore") || r.path.endsWith("/backups"))) return { status: 202 };
    if (r.method === "POST" && r.path.endsWith("/restic/forget")) return { status: 204 };
    return undefined;
  };
};

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, admin: true, totp: true });
  owner = await h.user({ discordId: "290000000000000001", name: "eigenaar" });
  creator = await h.user({ discordId: "290000000000000002", name: "maker" });
  restorer = await h.user({ discordId: "290000000000000003", name: "herstel" });
  scheduler = await h.user({ discordId: "290000000000000004", name: "planner" });
  stranger = await h.user({ discordId: "290000000000000005", name: "vreemde" });
  await admin.api.admin.s3Targets.create({ name: "Doel", endpoint: "http://127.0.0.1:9", bucket: "panel-backups", region: "us-east-1", pathStyle: true, accessKey: "AKTESTKEY", secretKey: "supersecretvalue" });
  const d = await admin.api.admin.servers.create({
    name: "Inc",
    ownerId: owner.id,
    nodeId: h.localNodeId,
    templateId: await h.templateId("testweb"),
    limits: { cpuPct: 100, ramMb: 256, swapMb: 0, diskMb: 1024 },
    allocationIds: [],
    variables: {},
    startOnInstall: true,
  });
  uuid = d.uuid;
  serverId = (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid)))[0]!.id;
  await owner.api.subusers.invite({ uuid, who: creator.discordId, permissions: ["backup.create"] });
  await owner.api.subusers.invite({ uuid, who: restorer.discordId, permissions: ["backup.restore"] });
  await owner.api.subusers.invite({ uuid, who: scheduler.discordId, permissions: ["schedule.manage"] });
}, 180_000);

describe("backups.settings / updateSettings", () => {
  it("standaardwaarden; bijwerken alleen met backup.create; lege retentie geweigerd", async () => {
    expect(await restorer.api.backups.settings({ uuid })).toEqual({ defaultKind: "full", retention: { keepLast: 10, keepDaily: 7, keepWeekly: 4 }, lastPruneAt: null, repositoryCreated: false });
    await expect(stranger.api.backups.settings({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(restorer.api.backups.updateSettings({ uuid, defaultKind: "incremental", retention: { keepLast: 5, keepDaily: 0, keepWeekly: 0 } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(creator.api.backups.updateSettings({ uuid, defaultKind: "incremental", retention: { keepLast: 0, keepDaily: 0, keepWeekly: 0 } })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RETENTION_EMPTY" });
    const s = await creator.api.backups.updateSettings({ uuid, defaultKind: "full", retention: { keepLast: 3, keepDaily: 2, keepWeekly: 1 } });
    expect(s).toMatchObject({ defaultKind: "full", retention: { keepLast: 3, keepDaily: 2, keepWeekly: 1 }, repositoryCreated: false });
  });
});

describe("incrementele backups", () => {
  let first = 0;
  let second = 0;

  it("create kind=incremental: repository met eigen wachtwoord (versleuteld), daemonverzoek met retentie en prune", async () => {
    accept();
    const b = await creator.api.backups.create({ uuid, name: "inc 1", includeDatabases: true, kind: "incremental" });
    first = b.id;
    expect(b).toMatchObject({ kind: "incremental", status: "running", snapshotId: null, sha256: null });
    const sent = h.daemon.last("POST", `/api/servers/${uuid}/restic/backups`)!.body as Record<string, unknown>;
    const [st] = await getDb().select().from(schema.serverBackupSettings).where(eq(schema.serverBackupSettings.serverId, serverId));
    const password = decrypt(st!.resticPasswordEnc!);
    expect(password.length).toBeGreaterThanOrEqual(32);
    expect(st!.resticPasswordEnc).not.toContain(password);
    expect(sent).toMatchObject({ backup_id: b.id, password, databases: [], ignore: ["/.panel-deploy"], retention: { keep_last: 3, keep_daily: 2, keep_weekly: 1 }, prune: true, s3: { bucket: "panel-backups", access_key: "AKTESTKEY" } });
    expect((await row(b.id))!.s3Key).toBe(`restic/${uuid}`);
    // Volgende backup: hetzelfde wachtwoord.
    const b2 = await creator.api.backups.create({ uuid, name: "inc 2", includeDatabases: false, kind: "incremental" });
    second = b2.id;
    expect((h.daemon.last("POST", `/api/servers/${uuid}/restic/backups`)!.body as Record<string, unknown>).password).toBe(password);
    expect((await creator.api.backups.settings({ uuid })).repositoryCreated).toBe(true);
  });

  it("rapport: snapshot-id en groottes; zonder snapshot-id 400; sha256 is niet nodig", async () => {
    expect((await report(first, { successful: true, sha256: "a".repeat(64), size_bytes: 10 })).status).toBe(400);
    expect((await report(first, { successful: true, snapshot_id: snap("a"), size_bytes: 5000, added_bytes: 3000, forgotten_snapshots: [], pruned: true })).status).toBe(204);
    expect(await row(first)).toMatchObject({ status: "completed", snapshotId: snap("a"), sizeBytes: 5000, addedBytes: 3000, sha256: null });
    const st = await creator.api.backups.settings({ uuid });
    expect(st.lastPruneAt).toBeInstanceOf(Date);
    // Prune is net gedaan: de volgende backup prunet niet (hooguit eens per dag).
    accept();
    const b3 = await creator.api.backups.create({ uuid, name: "inc 3", includeDatabases: false });
    expect(b3.kind).toBe("full"); // standaard van de server is full
    const b4 = await creator.api.backups.create({ uuid, name: "inc 4", includeDatabases: false, kind: "incremental" });
    expect((h.daemon.last("POST", `/api/servers/${uuid}/restic/backups`)!.body as Record<string, unknown>).prune).toBe(false);
    await report(b3.id, { successful: false, error: "x" });
    await report(b4.id, { successful: false, error: "x" });
  });

  it("vergeten snapshots: hun rijen verdwijnen, de nieuwe blijft", async () => {
    expect((await report(second, { successful: true, snapshot_id: snap("b"), size_bytes: 5100, added_bytes: 10, forgotten_snapshots: [snap("a"), snap("b")], pruned: false })).status).toBe(204);
    expect(await row(first)).toBeUndefined();
    expect(await row(second)).toMatchObject({ status: "completed", snapshotId: snap("b") });
  });

  it("list toont soort; downloadUrl kan niet (NOT_DOWNLOADABLE)", async () => {
    const list = await restorer.api.backups.list({ uuid });
    expect(list.find((b) => b.id === second)).toMatchObject({ kind: "incremental", snapshotId: snap("b"), addedBytes: 10, sizeBytes: 5100 });
    await expect(restorer.api.backups.downloadUrl({ id: second })).rejects.toMatchObject({ code: "CONFLICT", message: "NOT_DOWNLOADABLE" });
  });

  it("browse: backup.restore nodig; ls via de daemon; pad buiten de root geweigerd", async () => {
    h.daemon.override = (r) =>
      r.method === "POST" && r.path === `/api/servers/${uuid}/restic/ls`
        ? { status: 200, body: { entries: [{ name: "region", path: "world/region", type: "dir", size: 0, mtime: "2026-11-27T03:00:00Z" }, { name: "level.dat", path: "world/level.dat", type: "file", size: 7, mtime: "2026-11-27T03:00:00Z" }], truncated: false } }
        : undefined;
    await expect(creator.api.backups.browse({ id: second, path: "world" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(stranger.api.backups.browse({ id: second, path: "world" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r = await restorer.api.backups.browse({ id: second, path: "/world/" });
    expect(r).toMatchObject({ path: "world", truncated: false, entries: [{ name: "region", type: "dir" }, { name: "level.dat", path: "world/level.dat", sizeBytes: 7 }] });
    expect(r.entries[1]!.modifiedAt).toBeInstanceOf(Date);
    expect(h.daemon.last("POST", `/api/servers/${uuid}/restic/ls`)!.body).toMatchObject({ snapshot_id: snap("b"), path: "/world" });
    await expect(restorer.api.backups.browse({ id: second, path: "../etc" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Een volledige backup kun je niet bladeren.
    const full = (await getDb().select().from(schema.backups).where(eq(schema.backups.kind, "full")))[0]!;
    await expect(restorer.api.backups.browse({ id: full.id, path: "" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("restoreFiles: naar de oorspronkelijke plek en naar een submap; status restoring tot het rapport", async () => {
    accept();
    await expect(creator.api.backups.restoreFiles({ id: second, paths: ["world"], destination: "original" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(restorer.api.backups.restoreFiles({ id: second, paths: ["/"], destination: "original" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(restorer.api.backups.restoreFiles({ id: second, paths: ["a/../../etc"], destination: "original" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await restorer.api.backups.restoreFiles({ id: second, paths: ["/world/level.dat", "world/level.dat", "plugins"], destination: "original" })).toEqual({ ok: true, directory: null });
    const sent = h.daemon.last("POST", `/api/servers/${uuid}/restic/backups/${second}/restore`)!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ snapshot_id: snap("b"), paths: ["world/level.dat", "plugins"], databases: [] });
    expect(sent.destination).toBeUndefined();
    expect((await row(second))!.status).toBe("restoring");
    await expect(restorer.api.backups.restoreFiles({ id: second, paths: ["world"], destination: "original" })).rejects.toMatchObject({ code: "CONFLICT" });
    await reportRestoreRoute(req(`/api/remote/backups/${second}/restore`, { successful: true }), params({ backup_id: String(second) }));
    const r = await restorer.api.backups.restoreFiles({ id: second, paths: ["world"], destination: "subdir" });
    expect(r.directory).toMatch(/^\/restore-\d{4}-\d{2}-\d{2}-\d{4}$/);
    expect((h.daemon.last("POST", `/api/servers/${uuid}/restic/backups/${second}/restore`)!.body as Record<string, unknown>).destination).toBe(r.directory!.slice(1));
    await reportRestoreRoute(req(`/api/remote/backups/${second}/restore`, { successful: false, error: "none of the selected paths are in the snapshot" }), params({ backup_id: String(second) }));
    expect(await row(second)).toMatchObject({ status: "completed", error: "none of the selected paths are in the snapshot" });
  });

  it("restoreFiles: disk vol (507) → DISK_EXCEEDED en de status terug", async () => {
    h.daemon.override = (r) => (r.path.endsWith("/restore") ? { status: 507, body: { error: "disk_exceeded", message: "full" } } : undefined);
    await expect(restorer.api.backups.restoreFiles({ id: second, paths: ["world"], destination: "original" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "DISK_EXCEEDED" });
    expect((await row(second))!.status).toBe("completed");
  });

  it("volledig herstel van een snapshot via restic", async () => {
    accept();
    expect(await restorer.api.backups.restore({ id: second })).toEqual({ ok: true });
    const sent = h.daemon.last("POST", `/api/servers/${uuid}/restic/backups/${second}/restore`)!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ snapshot_id: snap("b"), databases: [] });
    expect(sent.paths).toBeUndefined();
    await reportRestoreRoute(req(`/api/remote/backups/${second}/restore`, { successful: true }), params({ backup_id: String(second) }));
  });

  it("delete: restic forget via de daemon; daemonfout laat de rij staan", async () => {
    h.daemon.override = (r) => (r.path.endsWith("/restic/forget") ? { status: 500, body: { error: "internal", message: "boom" } } : undefined);
    await expect(creator.api.backups.delete({ id: second })).rejects.toBeTruthy();
    expect(await row(second)).toBeTruthy();
    accept();
    expect(await creator.api.backups.delete({ id: second })).toEqual({ ok: true });
    expect(h.daemon.last("POST", `/api/servers/${uuid}/restic/forget`)!.body).toMatchObject({ snapshot_ids: [snap("b")] });
    expect(await row(second)).toBeUndefined();
  });

  it("volledige backups blijven werken; het maximum telt alleen volledige", async () => {
    accept();
    const f = await owner.api.backups.create({ uuid, name: "vol", includeDatabases: false, kind: "full" });
    expect(f.kind).toBe("full");
    expect(h.daemon.last("POST", `/api/servers/${uuid}/backups`)!.body).toMatchObject({ backup_id: f.id, key: `servers/${uuid}/${f.id}.tar.zst` });
    await report(f.id, { successful: false, error: "x" });
  });
});

describe("schema's met soort", () => {
  it("payload full/incremental; ongeldige soort geweigerd; tick start de gekozen soort", async () => {
    accept();
    await expect(scheduler.api.schedules.create({ uuid, name: "fout", cron: "0 4 * * *", action: "backup", payload: "weekly", active: true })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "INVALID_BACKUP_KIND" });
    const s = await scheduler.api.schedules.create({ uuid, name: "elk uur", cron: "0 * * * *", action: "backup", payload: "incremental", active: true });
    expect(s.payload).toBe("incremental");
    const plain = await scheduler.api.schedules.create({ uuid, name: "zonder", cron: "0 * * * *", action: "backup", payload: null, active: true });
    expect(plain.payload).toBeNull();
    await getDb().update(schema.schedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(schema.schedules.id, s.id));
    h.daemon.requests.length = 0;
    await tick();
    expect(h.daemon.requests.some((r) => r.method === "POST" && r.path === `/api/servers/${uuid}/restic/backups`)).toBe(true);
    const made = (await getDb().select().from(schema.backups).where(eq(schema.backups.serverId, serverId))).filter((b) => b.name.startsWith("elk uur"));
    expect(made).toHaveLength(1);
    expect(made[0]!.kind).toBe("incremental");
  });
});

describe("hulpfuncties", () => {
  it("cleanPath en restoreDirName", () => {
    expect(cleanPath("/world//region/")).toBe("world/region");
    expect(cleanPath("./a/./b")).toBe("a/b");
    expect(cleanPath("")).toBe("");
    expect(() => cleanPath("../x")).toThrow();
    expect(() => cleanPath("a\\b")).toThrow();
    expect(restoreDirName(new Date("2026-11-28T15:30:00Z"))).toBe("restore-2026-11-28-1630");
    expect(restoreDirName(new Date("2026-07-01T22:05:00Z"))).toBe("restore-2026-07-02-0005");
  });
});
