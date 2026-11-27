/**
 * Remote-API (daemon → panel, packages/api/panel-remote.yaml).
 * Authenticatie: Bearer <node-token>; de node wordt gevonden via sha256(token).
 */
import { verify as argonVerify } from "@node-rs/argon2";
import { ALL_PERMISSIONS, type ServerStatus } from "@panel/api";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { logActivity } from "./activity";
import { ensureBooted } from "./boot";
import { getDb, schema } from "./db";
import { safeEqual, sha256 } from "./lib/crypto";
import { jwks } from "./lib/jwt";
import { getLimiter } from "./lib/ratelimit";
import { sftpUsername } from "./servers-data";

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
      if (!node) return error(401, "unauthorized", "onbekend node-token");
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
  const b = await body(req, z.object({ version: z.string().max(100), disk_quota_mode: z.enum(["soft", "xfs"]) }));
  if (!b) return error(400, "bad_request");
  await getDb().update(schema.nodes).set({ daemonVersion: b.version, diskQuotaMode: b.disk_quota_mode, lastSeenAt: new Date() }).where(eq(schema.nodes.id, node.id));
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
  await logActivity({
    action: b.successful ? "server.install.completed" : "server.install.failed",
    serverId: s.id,
    metadata: b.successful ? {} : { error: b.error?.slice(0, 2000) ?? null },
  });
  return noContent();
});

export const reportStatus = remoteHandler<{ uuid: string }>(async (req, node, { uuid }) => {
  const b = await body(req, z.object({ state: DaemonState }));
  if (!b) return error(400, "bad_request");
  const s = await serverOnNode(uuid, node);
  if (!s) return error(404, "not_found");
  await getDb().update(schema.servers).set({ status: b.state as ServerStatus }).where(eq(schema.servers.id, s.id));
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
      await limiter.reset(userKey);
      await logActivity({ action: "server.sftp.login", userId: c.user.id, serverId: srv.id, ip: b.ip });
      return json(200, { server_uuid: srv.uuid, user_id: String(c.user.id), permissions: perms });
    }
  }
  return fail("invalid", srvs[0]?.id);
});
