/** Servers ophalen met alles wat ServerSummary/ServerDetail nodig heeft, plus rechten. */
import { ALL_PERMISSIONS, type Ctx, type Permission, type ServerDetail, type ServerStatus, type ServerSummary, type UserPublic } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { apiKeyOf } from "./apikey";
import { getDb, schema } from "./db";

type UserRow = typeof schema.users.$inferSelect;

export function userPublic(u: Pick<UserRow, "id" | "discordId" | "name" | "avatarUrl">): UserPublic {
  return { id: u.id, discordId: u.discordId ?? "000000000000000", name: u.name, avatarUrl: u.avatarUrl };
}

const owner = alias(schema.users, "owner");

export async function fetchServers(where: SQL | undefined, opts: { orderBy?: "name" | "id_desc"; limit?: number } = {}) {
  const db = getDb();
  let q = db
    .select({ server: schema.servers, owner, node: schema.nodes, template: schema.templates })
    .from(schema.servers)
    .innerJoin(owner, eq(owner.id, schema.servers.ownerId))
    .innerJoin(schema.nodes, eq(schema.nodes.id, schema.servers.nodeId))
    .innerJoin(schema.templates, eq(schema.templates.id, schema.servers.templateId))
    .where(where)
    .$dynamic();
  q = opts.orderBy === "id_desc" ? q.orderBy(desc(schema.servers.id)) : q.orderBy(asc(schema.servers.name), asc(schema.servers.id));
  if (opts.limit) q = q.limit(opts.limit);
  const rows = await q;
  const ids = rows.map((r) => r.server.id);
  const allocs = ids.length
    ? await db.select().from(schema.allocations).where(inArray(schema.allocations.serverId, ids)).orderBy(asc(schema.allocations.port))
    : [];
  const doms = ids.length
    ? await db.select({ serverId: schema.domains.serverId, hostname: schema.domains.hostname }).from(schema.domains).where(inArray(schema.domains.serverId, ids)).orderBy(asc(schema.domains.id))
    : [];
  return rows.map((r) => ({
    ...r,
    allocations: allocs.filter((a) => a.serverId === r.server.id).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.port - b.port),
    domains: doms.filter((d) => d.serverId === r.server.id).map((d) => d.hostname),
  }));
}

export type ServerBundle = Awaited<ReturnType<typeof fetchServers>>[number];

export async function fetchServerByUuid(uuid: string): Promise<ServerBundle | null> {
  const [b] = await fetchServers(eq(schema.servers.uuid, uuid));
  return b ?? null;
}

export function limitsOf(s: ServerBundle["server"]) {
  return { cpuPct: s.cpuPct, ramMb: s.ramMb, swapMb: s.swapMb, diskMb: s.diskMb };
}

export function toSummary(b: ServerBundle, viewerId: number, status?: ServerStatus): ServerSummary {
  const primary = b.allocations[0];
  return {
    uuid: b.server.uuid,
    shortId: b.server.uuid.slice(0, 8),
    name: b.server.name,
    type: b.server.type,
    status: status ?? b.server.status,
    templateName: b.template.name,
    nodeName: b.node.name,
    primaryAddress: b.server.type === "web" ? (b.domains[0] ?? null) : primary ? `${primary.ip}:${primary.port}` : null,
    limits: limitsOf(b.server),
    isOwner: b.server.ownerId === viewerId,
    owner: userPublic(b.owner),
    suspended: b.server.suspendedAt ? { reason: b.server.suspendedReason, at: b.server.suspendedAt } : null,
  };
}

/** SFTP-gebruikersnaam `<naam>.<shortId>`; de naam in kleine letters zonder rare tekens. */
export function sftpUsername(name: string | null, discordId: string | null, uuid: string): string {
  const base = (name ?? discordId ?? "user").toLowerCase().replace(/[^a-z0-9_-]+/g, "").slice(0, 32) || (discordId ?? "user");
  return `${base}.${uuid.slice(0, 8)}`;
}

export function toDetail(
  b: ServerBundle,
  viewer: { id: number; name: string | null; discordId: string | null },
  permissions: Permission[],
  storedVariables: Record<string, string>,
  live?: { status?: ServerStatus; installedAt?: Date | null },
): ServerDetail {
  return {
    ...toSummary(b, viewer.id, live?.status),
    permissions,
    allocations: b.allocations.map((a, i) => ({ id: a.id, nodeId: a.nodeId, ip: a.ip, port: a.port, serverUuid: b.server.uuid, primary: i === 0 })),
    variables: b.template.variables.map((v) => ({
      key: v.key,
      name: v.name,
      description: v.description ?? null,
      value: storedVariables[v.key] ?? v.default,
      default: v.default,
      userEditable: v.user_editable,
      pattern: v.pattern ?? null,
    })),
    node: { id: b.node.id, name: b.node.name, fqdn: b.node.fqdn },
    sftp: { host: b.node.fqdn, port: b.node.sftpPort, username: sftpUsername(viewer.name, viewer.discordId, b.server.uuid) },
    // supported: nog niet uit de template gelezen (slaapstand-agent)
    sleep: { supported: false, enabled: b.server.sleepEnabled, idleMinutes: b.server.sleepIdleMinutes },
    installedAt: live?.installedAt !== undefined ? live.installedAt : b.server.installedAt,
    createdAt: b.server.createdAt,
  };
}

export async function serverVariables(serverId: number): Promise<Record<string, string>> {
  const rows = await getDb().select().from(schema.serverVariables).where(eq(schema.serverVariables.serverId, serverId));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---------- rechten ----------

/** Volledige admin: in admin_discord_ids én TOTP aan én geverifieerd (zoals het admin-niveau). */
export function isFullAdmin(ctx: Ctx): boolean {
  const s = ctx.session;
  return !!s && s.isAdmin && s.totpEnabled && s.totpVerified;
}

export interface ServerAccess {
  bundle: ServerBundle;
  isOwner: boolean;
  /** Eigenaar of volledige admin: mag eigenaarsacties. */
  canManage: boolean;
  isSubuser: boolean;
  permissions: Permission[];
}

export async function accessFor(ctx: Ctx, bundle: ServerBundle): Promise<ServerAccess> {
  const a = await baseAccess(ctx, bundle);
  const key = apiKeyOf(ctx);
  if (!key || (!a.canManage && !a.isSubuser)) return a;
  // API-sleutel: geen eigenaarsacties, rechten = doorsnede van sleutel en gebruiker.
  return { ...a, canManage: false, isSubuser: true, permissions: a.permissions.filter((p) => key.permissions.includes(p)) };
}

async function baseAccess(ctx: Ctx, bundle: ServerBundle): Promise<ServerAccess> {
  const uid = ctx.session!.userId;
  const isOwner = bundle.server.ownerId === uid;
  if (isOwner || isFullAdmin(ctx)) return { bundle, isOwner, canManage: true, isSubuser: false, permissions: [...ALL_PERMISSIONS] };
  const [sub] = await getDb()
    .select({ permissions: schema.subusers.permissions })
    .from(schema.subusers)
    .where(and(eq(schema.subusers.serverId, bundle.server.id), eq(schema.subusers.userId, uid)));
  const perms = (sub?.permissions ?? []).filter((p): p is Permission => (ALL_PERMISSIONS as readonly string[]).includes(p));
  return { bundle, isOwner, canManage: false, isSubuser: !!sub, permissions: perms };
}

/**
 * Server opzoeken en recht controleren.
 * - `"any"`: eigenaar, admin of subuser (met welk recht dan ook)
 * - `"owner"`: eigenaar of admin
 * - een Permission: dat recht
 * Bestaat niet → NOT_FOUND; geen toegang → FORBIDDEN.
 */
export async function requireServer(ctx: Ctx, uuid: string, need: Permission | "any" | "owner"): Promise<ServerAccess> {
  const bundle = await fetchServerByUuid(uuid);
  if (!bundle) throw new TRPCError({ code: "NOT_FOUND", message: "SERVER_NOT_FOUND" });
  const a = await accessFor(ctx, bundle);
  if (!a.canManage && !a.isSubuser) throw new TRPCError({ code: "FORBIDDEN", message: "NO_ACCESS" });
  if (need === "any") return a;
  if (need === "owner") {
    if (!a.canManage) throw new TRPCError({ code: "FORBIDDEN", message: "OWNER_ONLY" });
    return a;
  }
  if (!a.permissions.includes(need)) throw new TRPCError({ code: "FORBIDDEN", message: `MISSING_PERMISSION: ${need}` });
  return a;
}
