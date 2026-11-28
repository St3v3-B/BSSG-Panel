/**
 * Incrementele backups (restic): instellingen per server en de repository
 * `s3:<endpoint>/<bucket>/restic/<uuid>` met een eigen willekeurig wachtwoord (versleuteld in
 * server_backup_settings.restic_password_enc). Het wachtwoord gaat per opdracht naar de daemon en
 * verder nergens heen. Zie docs/backups.md.
 */
import type { BackupKind, BackupRetention, BackupSettings } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "./db";
import { decrypt, encrypt } from "./lib/crypto";
import { s3Credentials } from "./lib/s3";
import { targetForNode, type S3Row } from "./backups";

type SettingsRow = typeof schema.serverBackupSettings.$inferSelect;

export const DEFAULT_RETENTION: BackupRetention = { keepLast: 10, keepDaily: 7, keepWeekly: 4 };
/** restic prune (traag, herschrijft packs) hooguit zo vaak; forget draait na elke backup. */
export const PRUNE_EVERY_MS = 24 * 3600_000;

export async function settingsRow(serverId: number): Promise<SettingsRow | null> {
  const [r] = await getDb().select().from(schema.serverBackupSettings).where(eq(schema.serverBackupSettings.serverId, serverId));
  return r ?? null;
}

export function toSettings(r: SettingsRow | null): BackupSettings {
  return {
    defaultKind: (r?.defaultKind as BackupKind | undefined) ?? "full",
    retention: r ? { keepLast: r.keepLast, keepDaily: r.keepDaily, keepWeekly: r.keepWeekly } : { ...DEFAULT_RETENTION },
    lastPruneAt: r?.lastPruneAt ?? null,
    repositoryCreated: !!r?.resticPasswordEnc,
  };
}

export async function defaultKind(serverId: number): Promise<BackupKind> {
  return toSettings(await settingsRow(serverId)).defaultKind;
}

export async function updateSettings(serverId: number, defaultKind: BackupKind, r: BackupRetention): Promise<BackupSettings> {
  if (r.keepLast + r.keepDaily + r.keepWeekly < 1) throw new TRPCError({ code: "BAD_REQUEST", message: "RETENTION_EMPTY" });
  const set = { defaultKind, keepLast: r.keepLast, keepDaily: r.keepDaily, keepWeekly: r.keepWeekly };
  const [row] = await getDb()
    .insert(schema.serverBackupSettings)
    .values({ serverId, ...set })
    .onConflictDoUpdate({ target: schema.serverBackupSettings.serverId, set })
    .returning();
  return toSettings(row!);
}

export interface Repo {
  row: SettingsRow;
  target: S3Row;
}

/**
 * De repository van een server; maakt wachtwoord en doel aan bij de eerste incrementele backup.
 * Het doel blijft daarna vast (de snapshots staan daar), ook als de node een ander standaarddoel krijgt.
 */
export async function ensureRepo(serverId: number, nodeId: number): Promise<Repo> {
  const db = getDb();
  const row = await settingsRow(serverId);
  if (row?.resticPasswordEnc && row.resticS3TargetId) {
    const [t] = await db.select().from(schema.s3Targets).where(eq(schema.s3Targets.id, row.resticS3TargetId));
    if (t) return { row, target: t };
  }
  // Doel weg (verwijderd) of nog niets: nieuw doel; een bestaand wachtwoord blijft (zelfde repo-pad op het nieuwe doel).
  const target = await targetForNode(nodeId);
  const t = schema.serverBackupSettings;
  await db.insert(t).values({ serverId }).onConflictDoNothing();
  // Het wachtwoord alleen zetten als er nog geen is: bij twee gelijktijdige eerste backups wint de eerste
  // (een tweede wachtwoord zou de al aangemaakte repository onbruikbaar maken).
  await db.update(t).set({ resticPasswordEnc: encrypt(randomBytes(32).toString("base64url")) }).where(and(eq(t.serverId, serverId), isNull(t.resticPasswordEnc)));
  const [saved] = await db.update(t).set({ resticS3TargetId: target.id }).where(eq(t.serverId, serverId)).returning();
  return { row: saved!, target };
}

/** Bestaande repository (voor herstel, bladeren, verwijderen); PRECONDITION_FAILED als die er niet (meer) is. */
export async function existingRepo(serverId: number, targetId: number | null): Promise<Repo> {
  const row = await settingsRow(serverId);
  const id = targetId ?? row?.resticS3TargetId ?? null;
  if (!row?.resticPasswordEnc || !id) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_REPOSITORY" });
  const [t] = await getDb().select().from(schema.s3Targets).where(eq(schema.s3Targets.id, id));
  if (!t) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "S3_TARGET_GONE" });
  return { row, target: t };
}

/** ResticRepo voor de daemon (s3 + wachtwoord). */
export const repoCredentials = (r: Repo) => ({ s3: s3Credentials(r.target), password: decrypt(r.row.resticPasswordEnc!) });

export const retentionOf = (r: SettingsRow) => ({ keep_last: r.keepLast, keep_daily: r.keepDaily, keep_weekly: r.keepWeekly });

export const pruneDue = (r: SettingsRow, now = new Date()) => !r.lastPruneAt || now.getTime() - r.lastPruneAt.getTime() >= PRUNE_EVERY_MS;

/** Pad uit een verzoek naar een pad relatief aan de serverroot ("" = root). Gooit bij `..`. */
export function cleanPath(p: string): string {
  const parts = p.split("/").filter((x) => x !== "" && x !== ".");
  if (parts.includes("..") || /[\u0000-\u001f\\]/.test(p)) throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_PATH" });
  return parts.join("/");
}

/** Submap voor "terugzetten naar een submap": restore-YYYY-MM-DD-HHMM (Europe/Amsterdam). */
export function restoreDirName(d = new Date()): string {
  const s = d.toLocaleString("sv-SE", { timeZone: "Europe/Amsterdam", hour12: false }); // 2026-11-28 16:30:05
  return `restore-${s.slice(0, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}`;
}
