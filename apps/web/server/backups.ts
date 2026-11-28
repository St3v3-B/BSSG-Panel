/** Gedeelde backuplogica: backups starten (handmatig en via schema), opruimen, S3-doel kiezen. */
import type { Backup, BackupKind } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray, lt, or } from "drizzle-orm";
import { logActivity } from "./activity";
import { notify, targetForServer } from "./notify";
import { getDb, schema } from "./db";
import { call, daemonFor } from "./daemon";
import { decrypt } from "./lib/crypto";
import { removeObject, s3Credentials } from "./lib/s3";
import type { ServerBundle } from "./servers-data";
import { defaultKind, ensureRepo, existingRepo, pruneDue, repoCredentials, retentionOf } from "./backups-restic";

type BackupRow = typeof schema.backups.$inferSelect;
export type S3Row = typeof schema.s3Targets.$inferSelect;

export const DEFAULT_MAX_BACKUPS = 7;
/** Een backup of herstel dat zo lang loopt zonder rapport van de daemon, geldt als mislukt. */
export const STALE_AFTER_MS = 12 * 3600_000;

export const toBackup = (b: BackupRow, serverUuid: string): Backup => ({
  id: b.id,
  serverUuid,
  name: b.name,
  sizeBytes: b.sizeBytes,
  sha256: b.sha256,
  status: b.status,
  includesDatabases: b.includesDatabases,
  error: b.error,
  createdAt: b.createdAt,
  completedAt: b.completedAt,
  kind: b.kind === "incremental" ? "incremental" : "full",
  snapshotId: b.snapshotId,
  addedBytes: b.addedBytes,
});

/** Maximum aantal backups per server (setting `max_backups_per_server`, standaard 7). */
export async function maxBackups(): Promise<number> {
  const [r] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, "max_backups_per_server"));
  const n = Number(r?.value);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_BACKUPS;
}

/** S3-doel voor een node: het standaarddoel van de node, anders het enige bestaande doel. */
export async function targetForNode(nodeId: number): Promise<S3Row> {
  const db = getDb();
  const [n] = await db.select({ s3TargetId: schema.nodes.s3TargetId }).from(schema.nodes).where(eq(schema.nodes.id, nodeId));
  if (n?.s3TargetId) {
    const [t] = await db.select().from(schema.s3Targets).where(eq(schema.s3Targets.id, n.s3TargetId));
    if (t) return t;
  }
  const all = await db.select().from(schema.s3Targets).limit(2);
  if (all.length === 1) return all[0]!;
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_S3_TARGET" });
}

/** Databasegegevens van de server voor de daemon (DatabaseCredentials). */
export async function databaseCredentials(serverId: number) {
  const rows = await getDb()
    .select({ d: schema.databases, h: schema.databaseHosts })
    .from(schema.databases)
    .innerJoin(schema.databaseHosts, eq(schema.databaseHosts.id, schema.databases.hostId))
    .where(eq(schema.databases.serverId, serverId))
    .orderBy(asc(schema.databases.id));
  return rows.map((r) => ({ name: r.d.name, host: r.h.host, port: r.h.port, username: r.d.username, password: decrypt(r.d.passwordEnc) }));
}

/** Minecraft-templates waarvan de wereld voor een backup bevroren wordt (save-off + save-all flush). */
const MINECRAFT_SLUGS = new Set(["paper", "folia", "fabric"]);
const FLUSH_WAIT_MS = 1500;

async function isOnline(b: ServerBundle): Promise<boolean> {
  try {
    return (await daemonFor(b.node).getServer(b.server.uuid, 2000)).state === "online";
  } catch {
    return false;
  }
}

/** Zet autosave uit en schrijft alles weg, zodat de backup een consistente wereld ziet. Doet niets als de server uit staat. */
export async function freezeWorld(b: ServerBundle): Promise<boolean> {
  if (b.server.type !== "game" || !MINECRAFT_SLUGS.has(b.template.slug) || !(await isOnline(b))) return false;
  try {
    await daemonFor(b.node).sendCommands(b.server.uuid, ["save-off", "save-all flush"]);
  } catch {
    return false;
  }
  await new Promise((r) => setTimeout(r, FLUSH_WAIT_MS));
  return true;
}

/** `save-on` na een backup (of een mislukte start ervan); alleen als de server nog draait. */
export async function thawWorld(b: ServerBundle): Promise<void> {
  if (b.server.type !== "game" || !MINECRAFT_SLUGS.has(b.template.slug) || !(await isOnline(b))) return;
  try {
    await daemonFor(b.node).sendCommands(b.server.uuid, ["save-on"]);
  } catch (e) {
    console.error(`[backups] save-on for ${b.server.uuid} failed:`, e);
  }
}

const backupKey = (uuid: string, id: number) => `servers/${uuid}/${id}.tar.zst`;
const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace("T", " ");

export interface StartBackupOptions {
  name?: string | null;
  includeDatabases: boolean;
  userId: number | null;
  scheduleId?: number;
  /** null/undefined = de standaard van de server. */
  kind?: BackupKind | null;
}

/** Maakt de rij aan en laat de daemon beginnen. Bij een fout wordt de rij `failed` en gooit hij. */
export async function startBackup(b: ServerBundle, o: StartBackupOptions): Promise<BackupRow> {
  const db = getDb();
  const kind = o.kind ?? (await defaultKind(b.server.id));
  const repo = kind === "incremental" ? await ensureRepo(b.server.id, b.node.id) : null;
  const target = repo ? repo.target : await targetForNode(b.node.id);
  const databases = o.includeDatabases ? await databaseCredentials(b.server.id) : [];
  const [row] = await db
    .insert(schema.backups)
    .values({ serverId: b.server.id, s3TargetId: target.id, name: o.name?.trim() || `Backup ${stamp()}`, s3Key: repo ? `restic/${b.server.uuid}` : "pending", status: "pending", includesDatabases: databases.length > 0, kind })
    .returning();
  const key = repo ? row!.s3Key : backupKey(b.server.uuid, row!.id);
  if (!repo) await db.update(schema.backups).set({ s3Key: key }).where(eq(schema.backups.id, row!.id));
  const frozen = await freezeWorld(b);
  try {
    if (repo) {
      await call(() =>
        daemonFor(b.node).createResticBackup(b.server.uuid, { backup_id: row!.id, ...repoCredentials(repo), ignore: ["/.panel-deploy"], databases, retention: retentionOf(repo.row), prune: pruneDue(repo.row) }),
      );
    } else {
      await call(() => daemonFor(b.node).createBackup(b.server.uuid, { backup_id: row!.id, s3: s3Credentials(target), key, ignore: ["/.panel-deploy"], databases }));
    }
  } catch (e) {
    await db.update(schema.backups).set({ status: "failed", error: errText(e), completedAt: new Date() }).where(eq(schema.backups.id, row!.id));
    if (frozen) await thawWorld(b);
    // Een schema draait zonder dat iemand meekijkt: dan melden (bij een handmatige backup ziet de gebruiker de fout).
    if (o.scheduleId) {
      const target = await targetForServer(b.server.id).catch(() => null);
      if (target) await notify({ kind: "backup_failed", name: row!.name, error: errText(e) }, target);
    }
    throw e;
  }
  const [running] = await db.update(schema.backups).set({ status: "running" }).where(and(eq(schema.backups.id, row!.id), eq(schema.backups.status, "pending"))).returning();
  await logActivity({ action: "server.backup.create", userId: o.userId, serverId: b.server.id, metadata: { id: row!.id, name: row!.name, kind, ...(o.scheduleId ? { scheduleId: o.scheduleId } : {}) } });
  return running ?? { ...row!, s3Key: key };
}

const errText = (e: unknown) => ((e as Error).message ?? String(e)).slice(0, 1000);

/** Verwijdert een backup uit S3 (incrementeel: restic forget via de daemon) en de database. Een fout gooit (rij blijft), tenzij `force`. */
export async function deleteBackup(row: BackupRow, force = false): Promise<void> {
  const db = getDb();
  if (row.kind === "incremental") {
    if (row.snapshotId) {
      try {
        const [srv] = await db.select({ s: schema.servers, n: schema.nodes }).from(schema.servers).innerJoin(schema.nodes, eq(schema.nodes.id, schema.servers.nodeId)).where(eq(schema.servers.id, row.serverId));
        const repo = await existingRepo(row.serverId, row.s3TargetId);
        await call(() => daemonFor(srv!.n).resticForget(srv!.s.uuid, { ...repoCredentials(repo), snapshot_ids: [row.snapshotId!] }));
      } catch (e) {
        if (!force) throw e;
        console.error(`[backups] snapshot ${row.snapshotId} not forgotten:`, e);
      }
    }
    await db.delete(schema.backups).where(eq(schema.backups.id, row.id));
    return;
  }
  if (row.s3TargetId && row.status !== "pending" && row.status !== "failed") {
    const [t] = await db.select().from(schema.s3Targets).where(eq(schema.s3Targets.id, row.s3TargetId));
    if (t) {
      try {
        await removeObject(t, row.s3Key);
      } catch (e) {
        if (!force) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `S3_ERROR: ${errText(e)}`, cause: e });
        console.error(`[backups] object ${row.s3Key} not deleted:`, e);
      }
    }
  }
  await db.delete(schema.backups).where(eq(schema.backups.id, row.id));
}

/** Houdt maximaal `maxBackups()` voltooide volledige backups per server: de oudste gaan uit S3 en de database. Incrementele: retentiebeleid (restic forget). */
export async function pruneBackups(serverId: number): Promise<number> {
  const max = await maxBackups();
  const done = await getDb()
    .select()
    .from(schema.backups)
    .where(and(eq(schema.backups.serverId, serverId), eq(schema.backups.status, "completed"), eq(schema.backups.kind, "full")))
    .orderBy(desc(schema.backups.id));
  let removed = 0;
  for (const old of done.slice(max)) {
    try {
      await deleteBackup(old);
      removed++;
      await logActivity({ action: "server.backup.prune", serverId, metadata: { id: old.id, name: old.name } });
    } catch (e) {
      console.error(`[backups] prune ${old.id} failed:`, e);
    }
  }
  return removed;
}

/** Backups en herstelacties waar de daemon nooit over rapporteerde, afsluiten. */
export async function failStaleBackups(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  const db = getDb();
  const stale = await db
    .update(schema.backups)
    .set({ status: "failed", error: "no report from the node", completedAt: now })
    .where(and(inArray(schema.backups.status, ["pending", "running"]), lt(schema.backups.createdAt, cutoff)))
    .returning({ serverId: schema.backups.serverId, name: schema.backups.name });
  for (const r of stale) {
    const target = await targetForServer(r.serverId).catch(() => null);
    if (target) await notify({ kind: "backup_failed", name: r.name, error: "no report from the node" }, target);
  }
  // Een herstel dat nooit rapporteerde: de backup zelf is nog goed.
  await db.update(schema.backups).set({ status: "completed" }).where(and(eq(schema.backups.status, "restoring"), lt(schema.backups.createdAt, cutoff)));
}

export async function countActive(serverId: number): Promise<number> {
  const [r] = await getDb()
    .select({ n: count() })
    .from(schema.backups)
    .where(and(eq(schema.backups.serverId, serverId), or(eq(schema.backups.status, "pending"), eq(schema.backups.status, "running"))));
  return Number(r?.n ?? 0);
}
