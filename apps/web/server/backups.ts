/** Gedeelde backuplogica: backups starten (handmatig en via schema), opruimen, S3-doel kiezen. */
import type { Backup } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray, lt, or } from "drizzle-orm";
import { logActivity } from "./activity";
import { getDb, schema } from "./db";
import { call, daemonFor } from "./daemon";
import { decrypt } from "./lib/crypto";
import { removeObject, s3Credentials } from "./lib/s3";
import type { ServerBundle } from "./servers-data";

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
  createdAt: b.createdAt,
  completedAt: b.completedAt,
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

const backupKey = (uuid: string, id: number) => `servers/${uuid}/${id}.tar.zst`;
const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace("T", " ");

export interface StartBackupOptions {
  name?: string | null;
  includeDatabases: boolean;
  userId: number | null;
  scheduleId?: number;
}

/** Maakt de rij aan en laat de daemon beginnen. Bij een fout wordt de rij `failed` en gooit hij. */
export async function startBackup(b: ServerBundle, o: StartBackupOptions): Promise<BackupRow> {
  const db = getDb();
  const target = await targetForNode(b.node.id);
  const databases = o.includeDatabases ? await databaseCredentials(b.server.id) : [];
  const [row] = await db
    .insert(schema.backups)
    .values({ serverId: b.server.id, s3TargetId: target.id, name: o.name?.trim() || `Backup ${stamp()}`, s3Key: "pending", status: "pending", includesDatabases: databases.length > 0 })
    .returning();
  const key = backupKey(b.server.uuid, row!.id);
  await db.update(schema.backups).set({ s3Key: key }).where(eq(schema.backups.id, row!.id));
  try {
    await call(() => daemonFor(b.node).createBackup(b.server.uuid, { backup_id: row!.id, s3: s3Credentials(target), key, ignore: [], databases }));
  } catch (e) {
    await db.update(schema.backups).set({ status: "failed", error: errText(e), completedAt: new Date() }).where(eq(schema.backups.id, row!.id));
    throw e;
  }
  const [running] = await db.update(schema.backups).set({ status: "running" }).where(and(eq(schema.backups.id, row!.id), eq(schema.backups.status, "pending"))).returning();
  await logActivity({ action: "server.backup.create", userId: o.userId, serverId: b.server.id, metadata: { id: row!.id, name: row!.name, ...(o.scheduleId ? { scheduleId: o.scheduleId } : {}) } });
  return running ?? { ...row!, s3Key: key };
}

const errText = (e: unknown) => ((e as Error).message ?? String(e)).slice(0, 1000);

/** Verwijdert een backup uit S3 en de database. Een S3-fout gooit (rij blijft), tenzij `force`. */
export async function deleteBackup(row: BackupRow, force = false): Promise<void> {
  const db = getDb();
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

/** Houdt maximaal `maxBackups()` voltooide backups per server: de oudste gaan uit S3 en de database. */
export async function pruneBackups(serverId: number): Promise<number> {
  const max = await maxBackups();
  const done = await getDb()
    .select()
    .from(schema.backups)
    .where(and(eq(schema.backups.serverId, serverId), eq(schema.backups.status, "completed")))
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
  await db
    .update(schema.backups)
    .set({ status: "failed", error: "no report from the node", completedAt: now })
    .where(and(inArray(schema.backups.status, ["pending", "running"]), lt(schema.backups.createdAt, cutoff)));
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
