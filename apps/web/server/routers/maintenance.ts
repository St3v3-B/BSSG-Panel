/**
 * admin.maintenance: onderhoudsmodus per node en evacueren.
 *
 * - In onderhoud (`nodes.maintenance` gezet) komen er geen nieuwe servers op de node: admin.servers.create,
 *   servers.create (quotum), pakketten (pickNode) en transfer naar de node weigeren (`assertNotInMaintenance`).
 *   Eigenaren zien een banner (ServerSummary.maintenance) en krijgen een melding (gebeurtenis `maintenance`).
 * - Evacueren: een wachtrij in Postgres (`node_evacuations` + `_items`). Een in-process runner verhuist `concurrency`
 *   servers tegelijk met de bestaande transfer-route (stop → kopie → start op het doel; bij een fout blijft de server
 *   op de oude node). Het doel is handmatig per server of automatisch: gekozen op het moment van verhuizen, op
 *   vrije RAM/disk/allocations, domeinen (websites en servers met domeinen alleen naar nodes met domeinen) en bij
 *   voorkeur dezelfde HTTP(S)-modus (eigen 80/443 of dezelfde relay).
 * - Na elke verhuizing: nieuw adres + de DNS-records die de eigenaar moet aanpassen (A naar de HTTP(S)-ingang,
 *   Minecraft A/SRV naar het directe IP en de nieuwe poort); de eigenaar krijgt een melding met een link naar het
 *   domeinscherm van de server.
 * - Een herstart van het panel: bij boot (`resumeEvacuations`) worden onderbroken items afgesloten en gaat de rest door.
 */
import type { Ctx, EvacuationPlanItem, EvacuationTarget, Implementation, Evacuation as EvacuationOut } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { logActivity } from "../activity";
import { getDb, schema } from "../db";
import { getNodesLive, isStale } from "../node-cache";
import { notify, serverHookOf } from "../notify";
import { httpIp, nodeIp } from "../relay";
import { fetchServerByUuid, fetchServers, type ServerBundle } from "../servers-data";
import { nodeById, nodeOut } from "./admin";
import { transfer } from "./transfer";

type NodeRow = typeof schema.nodes.$inferSelect;
type ItemRow = typeof schema.nodeEvacuationItems.$inferSelect;
type EvacRow = typeof schema.nodeEvacuations.$inferSelect;
type A = Implementation["admin"]["maintenance"];

const uid = (ctx: Ctx) => ctx.session!.userId;
const bad = (m: string) => new TRPCError({ code: "BAD_REQUEST", message: m });
const precondition = (m: string) => new TRPCError({ code: "PRECONDITION_FAILED", message: m });

/** Vervangbaar in tests (nep-transfer). */
export const evacuationDeps: { transfer: (opts: { input: { uuid: string; nodeId: number }; ctx: Ctx }) => Promise<unknown> } = {
  transfer: async (opts) => transfer(opts as Parameters<typeof transfer>[0]),
};

// ---------- capaciteit en doelkeuze ----------

interface Capacity {
  node: NodeRow;
  usedRam: number;
  usedDisk: number;
  freeAllocs: number;
  online: boolean | null;
}

async function capacities(): Promise<Map<number, Capacity>> {
  const db = getDb();
  const nodes = await db.select().from(schema.nodes).orderBy(asc(schema.nodes.id));
  const used = await db
    .select({ nodeId: schema.servers.nodeId, ram: sql<number>`coalesce(sum(${schema.servers.ramMb}), 0)::int`, disk: sql<number>`coalesce(sum(${schema.servers.diskMb}), 0)::int` })
    .from(schema.servers)
    .groupBy(schema.servers.nodeId);
  const free = await db
    .select({ nodeId: schema.allocations.nodeId, n: sql<number>`count(*)::int` })
    .from(schema.allocations)
    .where(isNull(schema.allocations.serverId))
    .groupBy(schema.allocations.nodeId);
  const live = await getNodesLive(nodes.map((n) => n.id));
  const u = new Map(used.map((r) => [r.nodeId, r]));
  const f = new Map(free.map((r) => [r.nodeId, r.n]));
  return new Map(
    nodes.map((n) => {
      const l = live.get(n.id);
      return [n.id, { node: n, usedRam: u.get(n.id)?.ram ?? 0, usedDisk: u.get(n.id)?.disk ?? 0, freeAllocs: f.get(n.id) ?? 0, online: l ? l.online && !isStale(l) : null }];
    }),
  );
}

interface Need {
  ramMb: number;
  diskMb: number;
  allocations: number;
  domains: boolean;
}

export function needOf(b: ServerBundle): Need {
  return {
    ramMb: b.server.ramMb,
    diskMb: b.server.diskMb,
    allocations: b.server.type === "web" ? 0 : Math.max(1, b.allocations.length),
    domains: b.server.type === "web" || b.domains.length > 0,
  };
}

const room = (max: number, used: number) => (max === 0 ? null : max - used);

/** Alle andere nodes als doel voor één server, beste eerst. */
export function rankTargets(src: NodeRow, need: Need, caps: Map<number, Capacity>): EvacuationTarget[] {
  const out: EvacuationTarget[] = [];
  for (const c of caps.values()) {
    if (c.node.id === src.id) continue;
    const freeRamMb = room(c.node.maxRamMb, c.usedRam);
    const freeDiskMb = room(c.node.maxDiskMb, c.usedDisk);
    let reason: string | null = null;
    if (c.node.maintenance) reason = "MAINTENANCE";
    else if (c.node.joinState && c.node.joinState !== "ready") reason = "NOT_READY";
    else if (c.online === false) reason = "OFFLINE";
    else if (need.domains && !c.node.supportsDomains) reason = "NO_DOMAINS";
    else if (freeRamMb !== null && freeRamMb < need.ramMb) reason = "RAM";
    else if (freeDiskMb !== null && freeDiskMb < need.diskMb) reason = "DISK";
    else if (c.freeAllocs < need.allocations) reason = "ALLOCATIONS";
    out.push({ nodeId: c.node.id, name: c.node.name, fits: reason === null, reason, freeRamMb, freeDiskMb, freeAllocations: c.freeAllocs, sameHttpMode: (c.node.httpRelayNodeId ?? null) === (src.httpRelayNodeId ?? null) });
  }
  const ram = (t: EvacuationTarget) => (t.freeRamMb === null ? Number.POSITIVE_INFINITY : t.freeRamMb);
  return out.sort((a, b) => Number(b.fits) - Number(a.fits) || Number(b.sameHttpMode) - Number(a.sameHttpMode) || ram(b) - ram(a) || a.nodeId - b.nodeId);
}

/** Reserveert de server op het doel in de (gesimuleerde) capaciteit. */
function reserve(caps: Map<number, Capacity>, nodeId: number, need: Need) {
  const c = caps.get(nodeId);
  if (!c) return;
  c.usedRam += need.ramMb;
  c.usedDisk += need.diskMb;
  c.freeAllocs -= need.allocations;
}

// ---------- DNS na een verhuizing ----------

type DnsRec = { hostname: string; type: "A" | "SRV"; value: string | null; changed: boolean | null };

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

async function dnsSnapshot(b: ServerBundle): Promise<{ address: string | null; dns: DnsRec[] }> {
  const db = getDb();
  const rows = await db.select().from(schema.domains).where(eq(schema.domains.serverId, b.server.id)).orderBy(asc(schema.domains.id));
  const direct = await safe(nodeIp(b.node));
  const http = rows.some((d) => d.protocol !== "minecraft") ? await safe(httpIp(b.node)) : null;
  const primary = b.allocations[0];
  const port = primary?.port ?? null;
  const dns: DnsRec[] = [];
  for (const d of rows) {
    const host = d.wildcard ? `*.${d.hostname}` : d.hostname;
    if (d.protocol === "minecraft") {
      dns.push({ hostname: host, type: "A", value: direct, changed: null });
      if (port) dns.push({ hostname: `_minecraft._tcp.${d.hostname}`, type: "SRV", value: `${d.hostname}:${port}`, changed: null });
    } else dns.push({ hostname: host, type: "A", value: http, changed: null });
  }
  const ip = primary ? (primary.ip === "0.0.0.0" && direct ? direct : primary.ip) : null;
  return { address: b.server.type === "game" && primary ? `${ip}:${primary.port}` : null, dns };
}

function diffDns(before: DnsRec[], after: DnsRec[]): DnsRec[] {
  const old = new Map(before.map((r) => [`${r.type}:${r.hostname}`, r.value]));
  return after.map((r) => {
    const o = old.get(`${r.type}:${r.hostname}`);
    return { ...r, changed: r.value === null || o === undefined || o === null ? null : r.value !== o };
  });
}

// ---------- uitvoer ----------

async function evacuationOut(ev: EvacRow): Promise<EvacuationOut> {
  const db = getDb();
  const items = await db
    .select({ i: schema.nodeEvacuationItems, n: schema.nodes.name })
    .from(schema.nodeEvacuationItems)
    .leftJoin(schema.nodes, eq(schema.nodes.id, schema.nodeEvacuationItems.targetNodeId))
    .where(eq(schema.nodeEvacuationItems.evacuationId, ev.id))
    .orderBy(asc(schema.nodeEvacuationItems.position), asc(schema.nodeEvacuationItems.id));
  return {
    id: ev.id,
    nodeId: ev.nodeId,
    status: ev.status as EvacuationOut["status"],
    concurrency: ev.concurrency,
    createdAt: ev.createdAt,
    finishedAt: ev.finishedAt,
    items: items.map(({ i, n }) => ({
      id: i.id,
      serverUuid: i.serverUuid,
      serverName: i.serverName,
      targetNodeId: i.targetNodeId,
      targetNodeName: n ?? null,
      auto: i.auto,
      status: i.status as EvacuationOut["items"][number]["status"],
      error: i.error,
      newAddress: i.result?.newAddress ?? null,
      dns: i.result?.dns ?? [],
      startedAt: i.startedAt,
      finishedAt: i.finishedAt,
    })),
  };
}

async function latestEvacuation(nodeId: number): Promise<EvacRow | null> {
  const [ev] = await getDb().select().from(schema.nodeEvacuations).where(eq(schema.nodeEvacuations.nodeId, nodeId)).orderBy(desc(schema.nodeEvacuations.id)).limit(1);
  return ev ?? null;
}

// ---------- meldingen ----------

/** Eén melding per eigenaar (met de namen van zijn servers op de node); servers-webhooks krijgen hem mee. */
async function notifyOwners(node: NodeRow, ended: boolean, m: { message: string | null; plannedStart: Date | null; plannedEnd: Date | null }) {
  const rows = await getDb().select().from(schema.servers).where(eq(schema.servers.nodeId, node.id)).orderBy(asc(schema.servers.id));
  const byOwner = new Map<number, (typeof rows)[number][]>();
  for (const r of rows) byOwner.set(r.ownerId, [...(byOwner.get(r.ownerId) ?? []), r]);
  for (const [owner, list] of byOwner) {
    const hooks = [...new Set(list.map((s) => serverHookOf(s)).filter((h): h is string => !!h))];
    await notify(
      { kind: "node_maintenance", nodeName: node.name, ...m, ended, servers: list.map((s) => s.name) },
      { server: list.length === 1 ? { uuid: list[0]!.uuid, name: list[0]!.name } : null, hooks, admin: false, users: [owner] },
    );
  }
}

// ---------- runner ----------

const runners = new Map<number, Promise<void>>();

/** Start (of laat lopen) de runner van een evacuatie. Tests kunnen op de belofte wachten. */
export function kickEvacuation(id: number): Promise<void> {
  let p = runners.get(id);
  if (!p) {
    p = runEvacuation(id)
      .catch((e) => console.error(`[evacuation] ${id}:`, e))
      .finally(() => runners.delete(id));
    runners.set(id, p);
  }
  return p;
}

/** Wacht tot alle lopende evacuaties klaar zijn (tests). */
export async function waitEvacuations(): Promise<void> {
  while (runners.size) await Promise.allSettled([...runners.values()]);
}

async function claimNext(evacId: number): Promise<ItemRow | null> {
  const res = await getDb().execute<{ id: number }>(sql`
    update node_evacuation_items set status = 'running', started_at = now(), error = null
    where id = (select id from node_evacuation_items where evacuation_id = ${evacId} and status = 'queued' order by position, id limit 1 for update skip locked)
    returning id`);
  const id = (res as unknown as Array<{ id: number }>)[0]?.id;
  if (!id) return null;
  const [row] = await getDb().select().from(schema.nodeEvacuationItems).where(eq(schema.nodeEvacuationItems.id, id));
  return row ?? null;
}

async function runEvacuation(id: number): Promise<void> {
  const db = getDb();
  const pool = new Set<Promise<void>>();
  for (;;) {
    const [ev] = await db.select().from(schema.nodeEvacuations).where(eq(schema.nodeEvacuations.id, id));
    if (!ev || ev.status !== "running") break;
    while (pool.size < ev.concurrency) {
      const item = await claimNext(id);
      if (!item) break;
      const p: Promise<void> = moveOne(ev, item)
        .catch((e) => console.error(`[evacuation] item ${item.id}:`, e))
        .finally(() => pool.delete(p));
      pool.add(p);
    }
    if (!pool.size) break;
    await Promise.race(pool);
  }
  await Promise.allSettled([...pool]);
  // Afronden zodra er niets meer wacht of loopt.
  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.nodeEvacuationItems)
    .where(and(eq(schema.nodeEvacuationItems.evacuationId, id), inArray(schema.nodeEvacuationItems.status, ["queued", "running"])));
  if ((left?.n ?? 0) === 0) {
    await db
      .update(schema.nodeEvacuations)
      .set({ status: sql`case when ${schema.nodeEvacuations.status} = 'running' then 'completed' else ${schema.nodeEvacuations.status} end`, finishedAt: new Date() })
      .where(and(eq(schema.nodeEvacuations.id, id), isNull(schema.nodeEvacuations.finishedAt)));
  }
}

function runnerCtx(userId: number): Ctx {
  return {
    session: { sessionId: "00000000-0000-0000-0000-000000000000", userId, discordId: "", isAdmin: true, isOwner: false, isEmergency: false, blocked: false, totpEnabled: true, totpVerified: true },
    ip: null,
    userAgent: "evacuation",
    resHeaders: new Headers(),
  };
}

async function finish(item: ItemRow, patch: Partial<typeof schema.nodeEvacuationItems.$inferInsert>) {
  await getDb().update(schema.nodeEvacuationItems).set({ finishedAt: new Date(), ...patch }).where(eq(schema.nodeEvacuationItems.id, item.id));
}

async function moveOne(ev: EvacRow, item: ItemRow): Promise<void> {
  const db = getDb();
  const b = await fetchServerByUuid(item.serverUuid);
  if (!b) return finish(item, { status: "failed", error: "SERVER_NOT_FOUND: the server was deleted" });
  if (b.node.id !== ev.nodeId) return finish(item, { status: "done", error: "already on another node" });
  if (!ev.createdBy) return finish(item, { status: "failed", error: "the admin who started the evacuation no longer exists" });

  let targetId = item.targetNodeId;
  if (item.auto || !targetId) {
    const best = rankTargets(b.node, needOf(b), await capacities()).find((t) => t.fits);
    if (!best) {
      const error = "NO_TARGET: no other node has enough free RAM, disk and allocations (or supports domains)";
      await finish(item, { status: "failed", error });
      await notify({ kind: "server_move_failed", nodeName: b.node.name, error }, { server: { uuid: b.server.uuid, name: b.server.name }, hooks: [], admin: true, users: [ev.createdBy] });
      return;
    }
    targetId = best.nodeId;
    await db.update(schema.nodeEvacuationItems).set({ targetNodeId: targetId }).where(eq(schema.nodeEvacuationItems.id, item.id));
  }
  const before = await dnsSnapshot(b);
  try {
    await evacuationDeps.transfer({ input: { uuid: b.server.uuid, nodeId: targetId }, ctx: runnerCtx(ev.createdBy) });
  } catch (e) {
    const error = ((e as Error).message ?? String(e)).slice(0, 1000);
    await finish(item, { status: "failed", error });
    await notify({ kind: "server_move_failed", nodeName: b.node.name, error }, { server: { uuid: b.server.uuid, name: b.server.name }, hooks: [], admin: true, users: [ev.createdBy] });
    return;
  }
  const after = await fetchServerByUuid(b.server.uuid);
  const snap = after ? await dnsSnapshot(after) : { address: null, dns: [] };
  const dns = diffDns(before.dns, snap.dns);
  await finish(item, { status: "done", error: null, result: { newAddress: snap.address, dns } });
  if (after) {
    await notify(
      { kind: "server_moved", fromNode: b.node.name, toNode: after.node.name, newAddress: snap.address !== before.address ? snap.address : null, dnsChanged: dns.filter((r) => r.changed !== false).map((r) => `${r.type} ${r.hostname}`) },
      { server: { uuid: after.server.uuid, name: after.server.name }, hooks: serverHookOf(after.server) ? [serverHookOf(after.server)!] : [], admin: false, users: [after.server.ownerId] },
    );
  }
}

/** Bij de start van het panel: onderbroken verhuizingen afsluiten en lopende evacuaties hervatten. */
export async function resumeEvacuations(): Promise<void> {
  const db = getDb();
  const evs = await db.select().from(schema.nodeEvacuations).where(isNull(schema.nodeEvacuations.finishedAt));
  for (const ev of evs) {
    const running = await db.select().from(schema.nodeEvacuationItems).where(and(eq(schema.nodeEvacuationItems.evacuationId, ev.id), eq(schema.nodeEvacuationItems.status, "running")));
    for (const it of running) {
      const [s] = await db.select({ nodeId: schema.servers.nodeId }).from(schema.servers).where(eq(schema.servers.uuid, it.serverUuid));
      const moved = !!s && s.nodeId !== ev.nodeId;
      await finish(it, moved ? { status: "done" } : { status: "failed", error: "INTERRUPTED: the panel restarted during this move; the server stays on the old node (start the evacuation again)" });
    }
    void kickEvacuation(ev.id);
  }
}

// ---------- procedures ----------

function parseDates(input: { plannedStart: Date | null; plannedEnd: Date | null }) {
  if (input.plannedStart && input.plannedEnd && input.plannedEnd <= input.plannedStart) throw bad("PLANNED_END_BEFORE_START");
}

export const maintenance: A = {
  set: async ({ input, ctx }) => {
    parseDates(input);
    const node = await nodeById(input.id);
    const prev = node.maintenance;
    const next = {
      since: prev?.since ?? new Date().toISOString(),
      message: input.message?.trim() || null,
      plannedStart: input.plannedStart?.toISOString() ?? null,
      plannedEnd: input.plannedEnd?.toISOString() ?? null,
      by: prev?.by ?? uid(ctx),
    };
    const [row] = await getDb().update(schema.nodes).set({ maintenance: next }).where(eq(schema.nodes.id, node.id)).returning();
    await logActivity({ action: prev ? "admin.node.maintenance.update" : "admin.node.maintenance.start", userId: uid(ctx), metadata: { nodeId: node.id, nodeName: node.name, message: next.message, plannedStart: next.plannedStart, plannedEnd: next.plannedEnd }, ip: ctx.ip, ctx });
    const changed = !prev || prev.message !== next.message || prev.plannedStart !== next.plannedStart || prev.plannedEnd !== next.plannedEnd;
    if (input.notifyOwners && changed) await notifyOwners(row!, false, { message: next.message, plannedStart: input.plannedStart, plannedEnd: input.plannedEnd });
    return nodeOut(row!);
  },

  end: async ({ input, ctx }) => {
    const node = await nodeById(input.id);
    const db = getDb();
    const [row] = await db.update(schema.nodes).set({ maintenance: null }).where(eq(schema.nodes.id, node.id)).returning();
    // Wachtende verhuizingen vervallen; wat al loopt maakt zijn verhuizing af. Geen terugverhuizing.
    const ev = await latestEvacuation(node.id);
    if (ev && ev.status === "running") await cancelEvacuation(ev);
    if (node.maintenance) {
      await logActivity({ action: "admin.node.maintenance.end", userId: uid(ctx), metadata: { nodeId: node.id, nodeName: node.name }, ip: ctx.ip, ctx });
      await notifyOwners(row!, true, { message: null, plannedStart: null, plannedEnd: null });
    }
    return nodeOut(row!);
  },

  plan: async ({ input }) => {
    const node = await nodeById(input.id);
    const where = input.uuids?.length ? and(eq(schema.servers.nodeId, node.id), inArray(schema.servers.uuid, input.uuids)) : eq(schema.servers.nodeId, node.id);
    const rows = await fetchServers(where, { orderBy: "name" });
    const caps = await capacities();
    const items: EvacuationPlanItem[] = [];
    // Grootste eerst plannen geeft de beste verdeling; de lijst blijft op naam.
    const order = [...rows].sort((a, b) => b.server.ramMb - a.server.ramMb);
    const pick = new Map<string, number | null>();
    for (const b of order) {
      const need = needOf(b);
      const best = rankTargets(node, need, caps).find((t) => t.fits) ?? null;
      pick.set(b.server.uuid, best?.nodeId ?? null);
      if (best) reserve(caps, best.nodeId, need);
    }
    const fresh = await capacities();
    for (const b of rows) {
      const need = needOf(b);
      items.push({
        uuid: b.server.uuid,
        name: b.server.name,
        type: b.server.type,
        ownerName: b.owner.name ?? b.owner.discordId,
        ramMb: need.ramMb,
        diskMb: need.diskMb,
        allocations: need.allocations,
        hasDomains: b.domains.length > 0,
        suggestedNodeId: pick.get(b.server.uuid) ?? null,
        targets: rankTargets(node, need, fresh),
      });
    }
    return { nodeId: node.id, items };
  },

  evacuate: async ({ input, ctx }) => {
    const node = await nodeById(input.id);
    if (!node.maintenance) throw precondition("NODE_NOT_IN_MAINTENANCE: put the node in maintenance first");
    const db = getDb();
    const prev = await latestEvacuation(node.id);
    if (prev && prev.status === "running") throw new TRPCError({ code: "CONFLICT", message: "EVACUATION_RUNNING" });
    const uuids = [...new Set(input.items.map((i) => i.uuid))];
    const rows = await fetchServers(inArray(schema.servers.uuid, uuids));
    const byUuid = new Map(rows.map((b) => [b.server.uuid, b]));
    for (const it of input.items) {
      const b = byUuid.get(it.uuid);
      if (!b || b.node.id !== node.id) throw bad(`SERVER_NOT_ON_NODE: ${it.uuid}`);
      if (it.nodeId !== null) {
        const t = await nodeById(it.nodeId).catch(() => null);
        if (!t || t.id === node.id || t.maintenance) throw bad(`TARGET_INVALID: node ${it.nodeId} for ${b.server.name}`);
      }
    }
    const seen = new Set<string>();
    const items = input.items.filter((i) => (seen.has(i.uuid) ? false : (seen.add(i.uuid), true)));
    const ev = await db.transaction(async (tx) => {
      const [e] = await tx.insert(schema.nodeEvacuations).values({ nodeId: node.id, concurrency: input.concurrency, createdBy: uid(ctx) }).returning();
      await tx.insert(schema.nodeEvacuationItems).values(
        items.map((it, i) => {
          const b = byUuid.get(it.uuid)!;
          return { evacuationId: e!.id, serverId: b.server.id, serverUuid: b.server.uuid, serverName: b.server.name, targetNodeId: it.nodeId, auto: it.nodeId === null, position: i };
        }),
      );
      return e!;
    });
    await logActivity({ action: "admin.node.evacuate", userId: uid(ctx), metadata: { nodeId: node.id, nodeName: node.name, evacuationId: ev.id, servers: items.length, concurrency: input.concurrency }, ip: ctx.ip, ctx });
    void kickEvacuation(ev.id);
    return evacuationOut(ev);
  },

  evacuation: async ({ input }) => {
    await nodeById(input.id);
    const ev = await latestEvacuation(input.id);
    return ev ? evacuationOut(ev) : null;
  },

  cancel: async ({ input, ctx }) => {
    const node = await nodeById(input.id);
    const ev = await latestEvacuation(node.id);
    if (!ev) throw new TRPCError({ code: "NOT_FOUND", message: "NO_EVACUATION" });
    const out = await cancelEvacuation(ev);
    await logActivity({ action: "admin.node.evacuate.cancel", userId: uid(ctx), metadata: { nodeId: node.id, evacuationId: ev.id }, ip: ctx.ip, ctx });
    return out;
  },
};

async function cancelEvacuation(ev: EvacRow): Promise<EvacuationOut> {
  const db = getDb();
  await db
    .update(schema.nodeEvacuationItems)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(and(eq(schema.nodeEvacuationItems.evacuationId, ev.id), eq(schema.nodeEvacuationItems.status, "queued")));
  const [running] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.nodeEvacuationItems)
    .where(and(eq(schema.nodeEvacuationItems.evacuationId, ev.id), eq(schema.nodeEvacuationItems.status, "running")));
  const [row] = await db
    .update(schema.nodeEvacuations)
    .set({ status: ev.status === "running" ? "cancelled" : ev.status, ...((running?.n ?? 0) === 0 ? { finishedAt: new Date() } : {}) })
    .where(eq(schema.nodeEvacuations.id, ev.id))
    .returning();
  return evacuationOut(row ?? ev);
}

