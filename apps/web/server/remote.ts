/**
 * Remote-API (daemon → panel, packages/api/panel-remote.yaml).
 * Authenticatie: Bearer <node-token>; de node wordt gevonden via sha256(token).
 */
import { crashTarget } from "./alarms";
import { verify as argonVerify } from "@node-rs/argon2";
import { ALL_PERMISSIONS, type ServerStatus } from "@panel/api";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { logActivity } from "./activity";
import { pruneBackups, thawWorld } from "./backups";
import { ensureBooted } from "./boot";
import { getDb, schema } from "./db";
import { safeEqual, sha256 } from "./lib/crypto";
import { jwks } from "./lib/jwt";
import { registerNodeDatabaseHost } from "./node-database";
import { notify, targetForServer } from "./notify";
import { getLimiter } from "./lib/ratelimit";
import { logImageUpdate, remoteImageSettings, storeImageReport } from "./image-updates";
import { fetchServerByUuid, sftpUsername } from "./servers-data";
import { applyServerState } from "./node-cache";
import { relayConfigFor, storeRelayReport } from "./relay";

type NodeRow = typeof schema.nodes.$inferSelect;

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export const error = (status: number, code: string, message?: string) => json(status, { error: code, ...(message ? { message } : {}) });
export const noContent = () => new Response(null, { status: 204 });

export async function authenticateNode(req: Request): Promise<NodeRow | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const [node] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.tokenHash, sha256(m[1]!)));
  return node ?? null;
}

/** Wrapper: boot afwachten, node authenticeren, fouten als JSON. */
export function remoteHandler<P>(fn: (req: Request, node: NodeRow, params: P) => Promise<Response>) {
  return async (req: Request, ctx: { params: Promise<P> }): Promise<Response> => {
    try {
      await ensureBooted();
      const node = await authenticateNode(req);
      if (!node) return error(401, "unauthorized", "unknown node token");
      return await fn(req, node, await ctx.params);
    } catch (e) {
      console.error(`[remote] ${new URL(req.url).pathname}:`, e);
      return error(500, "internal");
    }
  };
}

async function body<T extends z.ZodType>(req: Request, s: T): Promise<z.output<T> | null> {
  try {
    const r = s.safeParse(await req.json());
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const Uuid = z.string().uuid();
const DaemonState = z.enum(["installing", "install_failed", "offline", "starting", "online", "stopping", "disk_exceeded", "sleeping"]);

async function serverOnNode(uuid: string, node: NodeRow) {
  if (!Uuid.safeParse(uuid).success) return null;
  const [s] = await getDb()
    .select()
    .from(schema.servers)
    .where(and(eq(schema.servers.uuid, uuid), eq(schema.servers.nodeId, node.id)));
  return s ?? null;
}

// ---------- handlers ----------

export const getJwtKey = remoteHandler(async () => json(200, await jwks()));

export const nodeHello = remoteHandler(async (req, node) => {
  const b = await body(req, z.object({ version: z.string().max(100), disk_quota_mode: z.enum(["soft", "xfs"]), has_mariadb: z.boolean().optional() }));
  if (!b) return error(400, "bad_request");
  await getDb().update(schema.nodes).set({ daemonVersion: b.version, diskQuotaMode: b.disk_quota_mode, lastSeenAt: new Date() }).where(eq(schema.nodes.id, node.id));
  if (b.has_mariadb) await registerNodeDatabaseHost(node);
  return noContent();
});

export const reportInstall = remoteHandler<{ uuid: string }>(async (req, node, { uuid }) => {
  const b = await body(req, z.object({ successful: z.boolean(), error: z.string().nullish() }));
  if (!b) return error(400, "bad_request");
  const s = await serverOnNode(uuid, node);
  if (!s) return error(404, "not_found");
  // Starten na de installatie doet de daemon zelf (start_on_install in de spec).
  await getDb()
    .update(schema.servers)
    .set(b.successful ? { installedAt: new Date(), status: s.status === "installing" || s.status === "install_failed" ? "offline" : s.status } : { status: "install_failed" })
    .where(eq(schema.servers.id, s.id));
  const [after] = await getDb().select({ status: schema.servers.status, installedAt: schema.servers.installedAt }).from(schema.servers).where(eq(schema.servers.id, s.id));
  if (after) await applyServerState(node.id, uuid, after.status, after.installedAt).catch(() => {});
  await logActivity({
    action: b.successful ? "server.install.completed" : "server.install.failed",
    serverId: s.id,
    metadata: b.successful ? {} : { error: b.error?.slice(0, 2000) ?? null },
  });
  if (!b.successful) await notifyServer(s.id, { kind: "install_failed", error: b.error ?? "unknown error" });
  return noContent();
});

export const reportStatus = remoteHandler<{ uuid: string }>(async (req, node, { uuid }) => {
  const b = await body(req, z.object({ state: DaemonState }));
  if (!b) return error(400, "bad_request");
  const s = await serverOnNode(uuid, node);
  if (!s) return error(404, "not_found");
  await getDb().update(schema.servers).set({ status: b.state as ServerStatus }).where(eq(schema.servers.id, s.id));
  await applyServerState(node.id, uuid, b.state as ServerStatus).catch(() => {});
  return noContent();
});

// ---------- image-updates ----------

export const getImageUpdateSettings = remoteHandler(async () => json(200, await remoteImageSettings()));

export const reportImages = remoteHandler(async (req, node) => {
  const b = await body(
    req,
    z.object({
      servers: z.array(z.object({ uuid: Uuid, update_available: z.boolean(), reinstall_required: z.boolean(), checked_at: z.string().datetime({ offset: true }) }).passthrough()).max(5000),
    }),
  );
  if (!b) return error(400, "bad_request");
  // Alleen servers van deze node.
  const mine = new Set((await getDb().select({ uuid: schema.servers.uuid }).from(schema.servers).where(eq(schema.servers.nodeId, node.id))).map((r) => r.uuid));
  await storeImageReport(b.servers.filter((s) => mine.has(s.uuid)));
  return noContent();
});

export const reportImageUpdate = remoteHandler<{ uuid: string }>(async (req, node, { uuid }) => {
  const b = await body(
    req,
    z.object({ successful: z.boolean(), mode: z.enum(["auto", "manual"]), from_image_id: z.string().nullish(), to_image_id: z.string().nullish(), error: z.string().nullish() }),
  );
  if (!b) return error(400, "bad_request");
  const s = await serverOnNode(uuid, node);
  if (!s) return error(404, "not_found");
  if (b.successful) await getDb().update(schema.servers).set({ imageUpdateAvailable: false, imageReinstallRequired: false }).where(eq(schema.servers.id, s.id));
  await logImageUpdate(s.id, b);
  return noContent();
});

/** Melding voor een server (webhooks van server, eigenaar en admin). Gooit nooit. */
async function notifyServer(serverId: number, e: Parameters<typeof notify>[0]): Promise<void> {
  let target = await targetForServer(serverId).catch(() => null);
  // Crash = het offline-alarm van de server; de eigenaar kan het per server uitzetten (het admin-kanaal blijft).
  if (target && e.kind === "server_crashed") target = await crashTarget(target, serverId).catch(() => target);
  if (target) await notify(e, target);
}

const Event = z.object({
  type: z.enum(["crashed", "disk_warning", "disk_exceeded"]),
  exit_code: z.number().int().nullish(),
  oom: z.boolean().optional(),
  log_tail: z.array(z.string().max(2000)).max(30).optional(),
  crash_report: z.string().max(5000).nullish(),
  restart: z.enum(["restarted", "gave_up", "disabled"]).optional(),
  restart_attempt: z.number().int().min(0).optional(),
  disk_bytes: z.number().int().min(0).optional(),
  disk_limit_bytes: z.number().int().min(0).optional(),
});

export const reportEvent = remoteHandler<{ uuid: string }>(async (req, node, { uuid }) => {
  const b = await body(req, Event);
  if (!b) return error(400, "bad_request");
  const s = await serverOnNode(uuid, node);
  if (!s) return error(404, "not_found");
  if (b.type === "crashed") {
    const restart = b.restart ?? "disabled";
    await logActivity({ action: "server.crashed", serverId: s.id, metadata: { exitCode: b.exit_code ?? null, oom: b.oom ?? false, restart, attempt: b.restart_attempt ?? 0 } });
    await notifyServer(s.id, { kind: "server_crashed", exitCode: b.exit_code ?? null, oom: b.oom ?? false, logTail: b.log_tail ?? [], crashReport: b.crash_report ?? null, restart, attempt: b.restart_attempt ?? 0 });
  } else {
    await notifyServer(s.id, { kind: b.type, usedBytes: b.disk_bytes ?? 0, limitBytes: b.disk_limit_bytes ?? 0 });
  }
  return noContent();
});

// ---------- backups ----------

/** Backup op id, alleen als de server op deze node staat. */
async function backupOnNode(id: string, node: NodeRow) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  const [r] = await getDb()
    .select({ b: schema.backups, s: schema.servers })
    .from(schema.backups)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.backups.serverId))
    .where(and(eq(schema.backups.id, n), eq(schema.servers.nodeId, node.id)));
  return r ?? null;
}

export const reportBackup = remoteHandler<{ backup_id: string }>(async (req, node, { backup_id }) => {
  const b = await body(
    req,
    z.object({ successful: z.boolean(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullish(), size_bytes: z.number().int().min(0).nullish(), error: z.string().nullish() }),
  );
  if (!b || (b.successful && !b.sha256)) return error(400, "bad_request");
  const r = await backupOnNode(backup_id, node);
  if (!r) return error(404, "not_found");
  await getDb()
    .update(schema.backups)
    .set(b.successful ? { status: "completed", sha256: b.sha256, sizeBytes: b.size_bytes ?? null, error: null, completedAt: new Date() } : { status: "failed", error: b.error?.slice(0, 2000) ?? "unknown error", completedAt: new Date() })
    .where(eq(schema.backups.id, r.b.id));
  await logActivity({
    action: b.successful ? "server.backup.completed" : b.error === "cancelled" ? "server.backup.cancelled" : "server.backup.failed",
    serverId: r.s.id,
    metadata: b.successful ? { id: r.b.id, sizeBytes: b.size_bytes ?? null } : { id: r.b.id, error: b.error?.slice(0, 2000) ?? null },
  });
  const bundle = await fetchServerByUuid(r.s.uuid);
  if (bundle) await thawWorld(bundle);
  if (b.successful) {
    await pruneBackups(r.s.id);
    await notifyServer(r.s.id, { kind: "backup_completed", name: r.b.name, sizeBytes: b.size_bytes ?? null });
  } else if (b.error !== "cancelled") await notifyServer(r.s.id, { kind: "backup_failed", name: r.b.name, error: b.error ?? "unknown error" }); // afgebroken door de gebruiker: geen melding
  return noContent();
});

export const reportRestore = remoteHandler<{ backup_id: string }>(async (req, node, { backup_id }) => {
  const b = await body(req, z.object({ successful: z.boolean(), error: z.string().nullish() }));
  if (!b) return error(400, "bad_request");
  const r = await backupOnNode(backup_id, node);
  if (!r) return error(404, "not_found");
  // De backup zelf blijft goed, ook als het herstel mislukte.
  await getDb().update(schema.backups).set({ status: "completed", error: b.successful ? null : (b.error?.slice(0, 2000) ?? "restore failed") }).where(eq(schema.backups.id, r.b.id));
  await logActivity({
    action: b.successful ? "server.backup.restore.completed" : "server.backup.restore.failed",
    serverId: r.s.id,
    metadata: b.successful ? { id: r.b.id } : { id: r.b.id, error: b.error?.slice(0, 2000) ?? null },
  });
  return noContent();
});

// ---------- SFTP ----------

export const SFTP_LIMITS = { perIp: 30, perUser: 10, windowSeconds: 600 };

const forbidden = () => error(403, "forbidden", "onjuiste gegevens");

/** Rechten van een gebruiker op een server via SFTP: eigenaar alles, subuser zijn eigen rechten. */
async function sftpCandidates(serverId: number, ownerId: number) {
  const db = getDb();
  const owner = await db.select().from(schema.users).where(eq(schema.users.id, ownerId));
  const subs = await db
    .select({ user: schema.users, permissions: schema.subusers.permissions })
    .from(schema.subusers)
    .innerJoin(schema.users, eq(schema.users.id, schema.subusers.userId))
    .where(eq(schema.subusers.serverId, serverId));
  return [
    ...owner.map((user) => ({ user, permissions: [...ALL_PERMISSIONS] as string[] })),
    ...subs.map((s) => ({ user: s.user, permissions: s.permissions.filter((p) => (ALL_PERMISSIONS as readonly string[]).includes(p)) })),
  ];
}

async function checkSftpPassword(userId: number, serverId: number, password: string, perms: string[]): Promise<string[] | null> {
  const db = getDb();
  const [cred] = await db
    .select()
    .from(schema.sftpCredentials)
    .where(and(eq(schema.sftpCredentials.userId, userId), eq(schema.sftpCredentials.serverId, serverId)));
  if (cred) {
    try {
      if (await argonVerify(cred.passwordHash, password)) return perms;
    } catch {
      /* ongeldige hash */
    }
  }
  // API-sleutel: rechten = doorsnede van sleutel en gebruiker.
  if (password.length < 16) return null;
  const [key] = await db
    .select()
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.prefix, password.slice(0, 8)), eq(schema.apiKeys.userId, userId)));
  if (!key || !safeEqual(key.hash, sha256(password))) return null;
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;
  await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, key.id));
  return perms.filter((p) => key.permissions.includes(p));
}

export const sftpAuth = remoteHandler(async (req, node) => {
  const b = await body(req, z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(1000), ip: z.string().max(100) }));
  if (!b) return error(400, "bad_request");
  const username = b.username.toLowerCase();
  const limiter = getLimiter();
  const ipKey = `sftp:ip:${b.ip}`;
  const userKey = `sftp:user:${username}`;
  if ((await limiter.get(ipKey)) >= SFTP_LIMITS.perIp || (await limiter.get(userKey)) >= SFTP_LIMITS.perUser) {
    return error(429, "rate_limited", "te veel pogingen");
  }
  const fail = async (reason: string, serverId?: number) => {
    await limiter.hit(ipKey, SFTP_LIMITS.windowSeconds);
    await limiter.hit(userKey, SFTP_LIMITS.windowSeconds);
    await logActivity({ action: "server.sftp.failed", serverId: serverId ?? null, metadata: { username, reason }, ip: b.ip });
    return forbidden();
  };

  const dot = username.lastIndexOf(".");
  const shortId = username.slice(dot + 1);
  if (dot <= 0 || !/^[0-9a-f]{8}$/.test(shortId)) return fail("format");
  const srvs = await getDb()
    .select()
    .from(schema.servers)
    .where(and(eq(schema.servers.nodeId, node.id), sql`${schema.servers.uuid}::text like ${`${shortId}%`}`));
  for (const srv of srvs) {
    for (const c of await sftpCandidates(srv.id, srv.ownerId)) {
      if (sftpUsername(c.user.name, c.user.discordId, srv.uuid) !== username) continue;
      const perms = await checkSftpPassword(c.user.id, srv.id, b.password, c.permissions);
      if (!perms) continue;
      if (c.user.blocked) return fail("blocked", srv.id);
      if (!perms.includes("files.read")) return fail("no_files_read", srv.id);
      // Opgeschort: geen SFTP, ook niet met een API-sleutel (admins gebruiken het paneel).
      if (srv.suspendedAt) return fail("suspended", srv.id);
      await limiter.reset(userKey);
      await logActivity({ action: "server.sftp.login", userId: c.user.id, serverId: srv.id, ip: b.ip });
      return json(200, { server_uuid: srv.uuid, user_id: String(c.user.id), permissions: perms });
    }
  }
  return fail("invalid", srvs[0]?.id);
});

// ---------- HTTP(S)-relay ----------

export const getRelayConfig = remoteHandler(async (_req, node) => json(200, await relayConfigFor(node)));

export const reportRelayStatus = remoteHandler(async (req, node) => {
  const b = await body(
    req,
    z.object({
      edge_node_id: z.number().int(),
      connected: z.boolean(),
      connected_at: z.string().max(40).nullable().optional(),
      latency_ms: z.number().nullable().optional(),
      last_error: z.string().max(2000).nullable().optional(),
      last_error_at: z.string().max(40).nullable().optional(),
      reconnects: z.number().int().min(0).optional(),
      http_mode: z.enum(["direct", "relay"]).optional(),
    }),
  );
  if (!b) return error(400, "bad_request");
  // Alleen meldingen over de relay die het panel heeft toegewezen.
  if (b.edge_node_id !== node.httpRelayNodeId) return noContent();
  await storeRelayReport(node, b);
  return noContent();
});
