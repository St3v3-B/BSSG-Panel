/** backups.* (backup.create / backup.restore) en admin.s3Targets.*. */
import type { Ctx, Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { logActivity } from "../activity";
import { databaseCredentials, deleteBackup, startBackup, toBackup } from "../backups";
import { DaemonHttpError, call, daemonFor, toTrpcError } from "../daemon";
import { getDb, schema } from "../db";
import { decrypt, encrypt } from "../lib/crypto";
import { presignGet, s3Credentials, testTarget } from "../lib/s3";
import { isFullAdmin, requireServer, type ServerAccess } from "../servers-data";
import { assertPlanBackupRoom } from "../billing/plans";
import { cleanPath, existingRepo, repoCredentials, restoreDirName, settingsRow, toSettings, updateSettings } from "../backups-restic";

const ok = { ok: true as const };
const uid = (ctx: Ctx) => ctx.session!.userId;
type BackupRow = typeof schema.backups.$inferSelect;
type S3Row = typeof schema.s3Targets.$inferSelect;

/** Backup op id, met servercontrole voor `need`. */
async function backupFor(ctx: Ctx, id: number, need: "backup.create" | "backup.restore") {
  const [row] = await getDb()
    .select({ b: schema.backups, uuid: schema.servers.uuid })
    .from(schema.backups)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.backups.serverId))
    .where(eq(schema.backups.id, id));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "BACKUP_NOT_FOUND" });
  const a = await requireServer(ctx, row.uuid, need);
  return { b: row.b, a, uuid: row.uuid };
}

async function targetOf(b: BackupRow): Promise<S3Row> {
  const [t] = b.s3TargetId ? await getDb().select().from(schema.s3Targets).where(eq(schema.s3Targets.id, b.s3TargetId)) : [];
  if (!t) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "S3_TARGET_GONE" });
  return t;
}

const ACTIVE = ["pending", "running", "restoring"] as const;
const hasAny = (a: ServerAccess) => a.permissions.includes("backup.create") || a.permissions.includes("backup.restore");

export const backups: Implementation["backups"] = {
  list: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "any");
    if (!hasAny(a)) throw new TRPCError({ code: "FORBIDDEN", message: "MISSING_PERMISSION: backup.create" });
    const rows = await getDb().select().from(schema.backups).where(eq(schema.backups.serverId, a.bundle.server.id)).orderBy(desc(schema.backups.id));
    return rows.map((r) => toBackup(r, input.uuid));
  },

  create: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "backup.create");
    if (!isFullAdmin(ctx)) await assertPlanBackupRoom(a.bundle.server.id);
    const row = await startBackup(a.bundle, { name: input.name, includeDatabases: input.includeDatabases, userId: uid(ctx), kind: input.kind });
    return toBackup(row, input.uuid);
  },

  restore: async ({ input, ctx }) => {
    const { b, a, uuid } = await backupFor(ctx, input.id, "backup.restore");
    const incremental = b.kind === "incremental";
    if (b.status !== "completed" || !(incremental ? b.snapshotId : b.sha256)) throw new TRPCError({ code: "CONFLICT", message: "BACKUP_NOT_COMPLETED" });
    const target = await targetOf(b);
    const repo = incremental ? await existingRepo(b.serverId, b.s3TargetId) : null;
    const databases = b.includesDatabases ? await databaseCredentials(b.serverId) : [];
    await getDb().update(schema.backups).set({ status: "restoring", error: null }).where(eq(schema.backups.id, b.id));
    try {
      if (repo) await call(() => daemonFor(a.bundle.node).restoreResticBackup(uuid, b.id, { ...repoCredentials(repo), snapshot_id: b.snapshotId!, databases }));
      else await call(() => daemonFor(a.bundle.node).restoreBackup(uuid, b.id, { s3: s3Credentials(target), key: b.s3Key, sha256: b.sha256!, databases }));
    } catch (e) {
      await getDb().update(schema.backups).set({ status: "completed" }).where(eq(schema.backups.id, b.id));
      throw e;
    }
    await logActivity({ action: "server.backup.restore", userId: uid(ctx), serverId: b.serverId, metadata: { id: b.id, name: b.name }, ip: ctx.ip, ctx });
    return ok;
  },

  delete: async ({ input, ctx }) => {
    const { b } = await backupFor(ctx, input.id, "backup.create");
    if (b.status === "pending" || b.status === "running" || b.status === "restoring") throw new TRPCError({ code: "CONFLICT", message: "BACKUP_BUSY" });
    await deleteBackup(b);
    await logActivity({ action: "server.backup.delete", userId: uid(ctx), serverId: b.serverId, metadata: { id: b.id, name: b.name }, ip: ctx.ip, ctx });
    return ok;
  },

  downloadUrl: async ({ input, ctx }) => {
    const { b, uuid } = await backupFor(ctx, input.id, "backup.restore");
    if (b.status !== "completed" && b.status !== "restoring") throw new TRPCError({ code: "CONFLICT", message: "BACKUP_NOT_COMPLETED" });
    if (b.kind === "incremental") throw new TRPCError({ code: "CONFLICT", message: "NOT_DOWNLOADABLE" });
    const target = await targetOf(b);
    const seconds = 600;
    const filename = `${uuid.slice(0, 8)}-backup-${b.id}.tar.zst`;
    const url = await presignGet(target, b.s3Key, seconds, filename);
    await logActivity({ action: "server.backup.download", userId: uid(ctx), serverId: b.serverId, metadata: { id: b.id }, ip: ctx.ip, ctx });
    return { url, expiresAt: new Date(Date.now() + seconds * 1000) };
  },

  progress: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "any");
    if (!hasAny(a)) throw new TRPCError({ code: "FORBIDDEN", message: "MISSING_PERMISSION: backup.create" });
    // Alleen de daemon vragen als er volgens de database iets loopt.
    const [active] = await getDb()
      .select({ id: schema.backups.id })
      .from(schema.backups)
      .where(and(eq(schema.backups.serverId, a.bundle.server.id), inArray(schema.backups.status, ACTIVE)))
      .limit(1);
    if (!active) return null;
    let p;
    try {
      p = await daemonFor(a.bundle.node).backupProgress(input.uuid);
    } catch {
      return null; // node onbereikbaar of oude daemon: de UI valt terug op "loopt"
    }
    if (!p) return null;
    return {
      backupId: p.backup_id,
      operation: p.operation,
      phase: p.phase,
      bytes: p.bytes,
      totalBytes: p.total_bytes,
      percent: Math.max(0, Math.min(100, p.percent)),
      etaSeconds: p.eta_seconds ?? null,
      startedAt: new Date(p.started_at),
      cancellable: p.cancellable,
    };
  },

  cancel: async ({ input, ctx }) => {
    const [row] = await getDb().select({ status: schema.backups.status }).from(schema.backups).where(eq(schema.backups.id, input.id));
    const restoring = row?.status === "restoring";
    const { b, a, uuid } = await backupFor(ctx, input.id, restoring ? "backup.restore" : "backup.create");
    if (!(ACTIVE as readonly string[]).includes(b.status)) throw new TRPCError({ code: "CONFLICT", message: "BACKUP_NOT_RUNNING" });
    try {
      await daemonFor(a.bundle.node).cancelBackup(uuid, b.id);
    } catch (e) {
      if (e instanceof DaemonHttpError && e.status === 404 && e.code === "not_running") throw new TRPCError({ code: "CONFLICT", message: "BACKUP_NOT_RUNNING" });
      if (e instanceof DaemonHttpError && e.status === 409) throw new TRPCError({ code: "CONFLICT", message: "BACKUP_NOT_CANCELLABLE" });
      throw toTrpcError(e);
    }
    await logActivity({ action: restoring ? "server.backup.restore.cancel" : "server.backup.cancel", userId: uid(ctx), serverId: b.serverId, metadata: { id: b.id, name: b.name }, ip: ctx.ip, ctx });
    return ok;
  },

  // ---------- incrementeel (restic) ----------

  settings: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "any");
    if (!hasAny(a)) throw new TRPCError({ code: "FORBIDDEN", message: "MISSING_PERMISSION: backup.create" });
    return toSettings(await settingsRow(a.bundle.server.id));
  },

  updateSettings: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "backup.create");
    const out = await updateSettings(a.bundle.server.id, input.defaultKind, input.retention);
    await logActivity({ action: "server.backup.settings", userId: uid(ctx), serverId: a.bundle.server.id, metadata: { defaultKind: input.defaultKind, ...input.retention }, ip: ctx.ip, ctx });
    return out;
  },

  browse: async ({ input, ctx }) => {
    const { b, a, uuid } = await backupFor(ctx, input.id, "backup.restore");
    if (b.kind !== "incremental") throw new TRPCError({ code: "CONFLICT", message: "NOT_INCREMENTAL" });
    if ((b.status !== "completed" && b.status !== "restoring") || !b.snapshotId) throw new TRPCError({ code: "CONFLICT", message: "BACKUP_NOT_COMPLETED" });
    const path = cleanPath(input.path);
    const repo = await existingRepo(b.serverId, b.s3TargetId);
    const r = await call(() => daemonFor(a.bundle.node).resticLs(uuid, { ...repoCredentials(repo), snapshot_id: b.snapshotId!, path: `/${path}` }));
    return {
      path,
      entries: r.entries.map((e) => ({ name: e.name, path: e.path, type: e.type, sizeBytes: e.size, modifiedAt: e.mtime && !e.mtime.startsWith("0001-") ? new Date(e.mtime) : null })),
      truncated: r.truncated,
    };
  },

  restoreFiles: async ({ input, ctx }) => {
    const { b, a, uuid } = await backupFor(ctx, input.id, "backup.restore");
    if (b.kind !== "incremental") throw new TRPCError({ code: "CONFLICT", message: "NOT_INCREMENTAL" });
    if (b.status !== "completed" || !b.snapshotId) throw new TRPCError({ code: "CONFLICT", message: "BACKUP_NOT_COMPLETED" });
    const paths = [...new Set(input.paths.map(cleanPath))];
    if (paths.some((p) => p === "")) throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_PATH" });
    const dir = input.destination === "subdir" ? restoreDirName() : null;
    const repo = await existingRepo(b.serverId, b.s3TargetId);
    await getDb().update(schema.backups).set({ status: "restoring", error: null }).where(eq(schema.backups.id, b.id));
    try {
      await call(() => daemonFor(a.bundle.node).restoreResticBackup(uuid, b.id, { ...repoCredentials(repo), snapshot_id: b.snapshotId!, databases: [], paths, ...(dir ? { destination: dir } : {}) }));
    } catch (e) {
      await getDb().update(schema.backups).set({ status: "completed" }).where(eq(schema.backups.id, b.id));
      throw e;
    }
    await logActivity({ action: "server.backup.restore_files", userId: uid(ctx), serverId: b.serverId, metadata: { id: b.id, name: b.name, paths: paths.slice(0, 20), count: paths.length, directory: dir }, ip: ctx.ip, ctx });
    return { ok: true as const, directory: dir ? `/${dir}` : null };
  },
};


// ---------- admin.s3Targets ----------

const toTarget = (t: S3Row, preview: string) => ({ id: t.id, name: t.name, endpoint: t.endpoint, bucket: t.bucket, region: t.region, pathStyle: t.pathStyle, accessKeyPreview: preview });
const out = (t: S3Row) => toTarget(t, decrypt(t.accessKeyEnc).slice(0, 4));

async function targetById(id: number): Promise<S3Row> {
  const [t] = await getDb().select().from(schema.s3Targets).where(eq(schema.s3Targets.id, id));
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "S3_TARGET_NOT_FOUND" });
  return t;
}

export const s3Targets: Implementation["admin"]["s3Targets"] = {
  list: async () => (await getDb().select().from(schema.s3Targets).orderBy(asc(schema.s3Targets.id))).map(out),

  create: async ({ input, ctx }) => {
    const [t] = await getDb()
      .insert(schema.s3Targets)
      .values({ name: input.name, endpoint: input.endpoint.replace(/\/+$/, ""), bucket: input.bucket, region: input.region, pathStyle: input.pathStyle, accessKeyEnc: encrypt(input.accessKey), secretKeyEnc: encrypt(input.secretKey) })
      .returning();
    await logActivity({ action: "admin.s3_target.create", userId: uid(ctx), metadata: { id: t!.id, name: t!.name }, ip: ctx.ip, ctx });
    return out(t!);
  },

  update: async ({ input, ctx }) => {
    const { id, accessKey, secretKey, endpoint, ...rest } = input;
    const set: Partial<typeof schema.s3Targets.$inferInsert> = { ...rest };
    if (endpoint) set.endpoint = endpoint.replace(/\/+$/, "");
    if (accessKey) set.accessKeyEnc = encrypt(accessKey);
    if (secretKey) set.secretKeyEnc = encrypt(secretKey);
    await targetById(id);
    const [t] = Object.keys(set).length ? await getDb().update(schema.s3Targets).set(set).where(eq(schema.s3Targets.id, id)).returning() : [await targetById(id)];
    await logActivity({ action: "admin.s3_target.update", userId: uid(ctx), metadata: { id, fields: Object.keys(input).filter((k) => k !== "id") }, ip: ctx.ip, ctx });
    return out(t!);
  },

  delete: async ({ input, ctx }) => {
    const t = await targetById(input.id);
    const [used] = await getDb().select({ n: count() }).from(schema.backups).where(eq(schema.backups.s3TargetId, t.id));
    if (Number(used?.n ?? 0) > 0) throw new TRPCError({ code: "CONFLICT", message: "S3_TARGET_IN_USE" });
    await getDb().delete(schema.s3Targets).where(eq(schema.s3Targets.id, t.id)); // nodes.s3_target_id wordt null
    await logActivity({ action: "admin.s3_target.delete", userId: uid(ctx), metadata: { id: t.id, name: t.name }, ip: ctx.ip, ctx });
    return ok;
  },

  test: async ({ input }) => testTarget(await targetById(input.id)),
};
