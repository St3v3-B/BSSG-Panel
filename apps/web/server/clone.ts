/**
 * Server dupliceren (servers.clone*): een nieuwe server met dezelfde template, variabelen en limieten en een
 * kopie van de bestanden, als achtergrondtaak met stappen (zoals de one-click apps).
 *
 * Hergebruik in plaats van nieuwe kopieercode:
 * - zelfde node: `POST /transfer/copy` van de daemon (ExportTar → ImportTar op de node zelf, de data passeert
 *   het panel niet); oudere daemons zonder dat pad: dezelfde tar-stroom als bij verplaatsen;
 * - andere node: de tar-stroom van verplaatsen (bron-daemon → panel → doel-daemon), met een bytesteller;
 * - een draaiende bron blijft draaien (`live`); Minecraft-werelden worden bevroren zoals bij een backup
 *   (save-off + save-all flush, daarna save-on);
 * - databases: nieuwe database + gebruiker via `createServerDatabase` (telt mee in het quotum), dan
 *   dump → import via de daemon-endpoints `/api/db/*`. Configbestanden worden NIET herschreven: de kopie wijst
 *   tot de gebruiker dat aanpast nog naar de oude database (de taak geeft de nieuwe namen terug).
 *
 * Fout of annuleren: de half gemaakte server gaat weg met `deleteServerFully` (daemon, routes, databases,
 * allocations). De bron verandert nooit (behalve save-off/save-on tijdens het kopiëren).
 */
import { randomUUID } from "node:crypto";
import { bedrockPlatform, type CloneJob, type CloneOptions, type CloneStepKey, type Ctx, type Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { logActivity } from "./activity";
import { forbidApiKey } from "./apikey";
import { freezeWorld, thawWorld } from "./backups";
import { bedrockAllocation } from "./bedrock";
import { call, DaemonHttpError, daemonFor, toTrpcError, type DaemonClient } from "./daemon";
import { getDb, schema } from "./db";
import { DEFAULT_BEDROCK_PORT, geyserConfig, geyserConfigPath } from "./lib/geyser";
import { FORWARDING_VAR, SECRET_VAR, isBackend, isProxy } from "./network";
import { notify } from "./notify";
import { assignAllocations, checkAllocations, deleteServerFully, nodeById } from "./routers/admin";
import { createServerDatabase, defaultHost } from "./routers/databases";
import { domains as domainProcs } from "./routers/domains";
import { checkLimits, exceeded, lockQuota, usageFor } from "./routers/quotas";
import { buildServerSpec } from "./spec";
import { accessFor, autoRestartOf, fetchServerByUuid, imagePolicyOf, isFullAdmin, limitsOf, requireServer, serverVariables, sleepOf, type ServerBundle } from "./servers-data";

type Row = typeof schema.serverClones.$inferSelect;
type Step = Row["steps"][number];
type NodeRow = typeof schema.nodes.$inferSelect;

/** Taken die dit proces uitvoert (met hun AbortController); een `running`-rij die hier niet in staat, is met een herstart gestorven. */
const active = new Map<number, AbortController>();
/** Instelbaar in tests. */
export const cloneTiming = { progressMs: 2000, stateWaitMs: 60_000, pollMs: 500 };

const bad = (m: string) => new TRPCError({ code: "BAD_REQUEST", message: m });
const precondition = (m: string) => new TRPCError({ code: "PRECONDITION_FAILED", message: m });
const errText = (e: unknown) => ((e as Error)?.message ?? String(e)).slice(0, 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Canceled extends Error {
  constructor() {
    super("CANCELED");
  }
}

// ---------- weergave ----------

export function toCloneJob(r: Row, exists: { source: boolean; target: boolean }): CloneJob {
  return {
    id: r.id,
    status: r.status,
    source: { uuid: r.sourceUuid, name: r.sourceName, exists: exists.source },
    target: { uuid: r.targetUuid, name: r.targetName, exists: exists.target },
    steps: r.steps.map((s) => ({ key: s.key as CloneStepKey, status: s.status })),
    sameNode: r.options.sameNode,
    live: r.options.live,
    bytesCopied: r.bytesCopied,
    bytesTotal: r.bytesTotal,
    databases: r.databases,
    domain: r.options.domain,
    warnings: r.warnings,
    errorCode: r.errorCode,
    error: r.error,
    startedAt: r.createdAt,
    finishedAt: r.finishedAt,
  };
}
const view = (r: Row) => toCloneJob(r, { source: r.sourceServerId !== null, target: r.targetServerId !== null });

/** Running-rijen zonder levend proces (panel herstart) of te oud: mislukt, en de half gemaakte server weg. */
export async function reapStaleClones(where?: { serverId: number }): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.serverClones)
    .where(and(eq(schema.serverClones.status, "running"), where ? or(eq(schema.serverClones.sourceServerId, where.serverId), eq(schema.serverClones.targetServerId, where.serverId)) : undefined));
  for (const r of rows) {
    if (active.has(r.id) && Date.now() - r.createdAt.getTime() < 6 * 3600_000) continue;
    active.get(r.id)?.abort();
    const [claimed] = await db
      .update(schema.serverClones)
      .set({ status: "failed", errorCode: "INTERRUPTED", error: "The copy was interrupted (panel restarted or timed out).", finishedAt: new Date(), steps: r.steps.map((s) => (s.status === "running" ? { ...s, status: "failed" as const } : s)) })
      .where(and(eq(schema.serverClones.id, r.id), eq(schema.serverClones.status, "running")))
      .returning();
    if (claimed?.targetServerId) await removeTarget(r.targetUuid).catch((e) => console.error("[clone] cleanup:", e));
  }
}

async function removeTarget(uuid: string): Promise<void> {
  const b = await fetchServerByUuid(uuid);
  if (!b) return;
  await deleteServerFully(b, async () => undefined);
}

/** Lopende kopie waar deze server het doel van is (dan geen power/verwijderen). */
export async function cloneTargetBusy(serverId: number): Promise<boolean> {
  const [r] = await getDb()
    .select({ id: schema.serverClones.id })
    .from(schema.serverClones)
    .where(and(eq(schema.serverClones.targetServerId, serverId), eq(schema.serverClones.status, "running")));
  return !!r && active.has(r.id);
}

// ---------- wat kan er ----------

interface Plan {
  src: ServerBundle;
  javaCount: number;
  oldBedrock: ReturnType<typeof bedrockAllocation>;
  copyable: Array<{ d: typeof schema.databases.$inferSelect; h: typeof schema.databaseHosts.$inferSelect }>;
  external: string[];
  notes: CloneOptions["notes"];
}

async function plan(src: ServerBundle): Promise<Plan> {
  const db = getDb();
  const oldBedrock = src.server.type === "game" && bedrockPlatform(src.template.slug) ? bedrockAllocation(src) : null;
  const javaCount = src.allocations.filter((a) => a.id !== oldBedrock?.id).length;
  const dbRows = await db
    .select({ d: schema.databases, h: schema.databaseHosts })
    .from(schema.databases)
    .innerJoin(schema.databaseHosts, eq(schema.databaseHosts.id, schema.databases.hostId))
    .where(eq(schema.databases.serverId, src.server.id))
    .orderBy(asc(schema.databases.id));
  const copyable = dbRows.filter((r) => r.h.daemonManaged && r.h.nodeId !== null);
  const external = dbRows.filter((r) => !copyable.includes(r)).map((r) => r.d.name);
  const notes: CloneOptions["notes"] = [];
  if (isProxy(src)) notes.push("proxy_members_not_cloned");
  const [member] = await db.select({ id: schema.networkMembers.id }).from(schema.networkMembers).where(eq(schema.networkMembers.backendServerId, src.server.id));
  if (member) notes.push("backend_not_in_network");
  if (oldBedrock) notes.push("bedrock_new_port");
  if (src.domains.length) notes.push("domains_not_cloned");
  const [sub] = await db.select({ n: count() }).from(schema.subusers).where(eq(schema.subusers.serverId, src.server.id));
  if ((sub?.n ?? 0) > 0) notes.push("subusers_not_cloned");
  if (external.length) notes.push("external_databases");
  return { src, javaCount, oldBedrock, copyable, external, notes };
}

async function runningFor(sourceId: number): Promise<Row | null> {
  const [r] = await getDb().select().from(schema.serverClones).where(and(eq(schema.serverClones.sourceServerId, sourceId), eq(schema.serverClones.status, "running"))).orderBy(desc(schema.serverClones.id)).limit(1);
  return r ?? null;
}

async function liveState(b: ServerBundle): Promise<string | null> {
  try {
    return (await daemonFor(b.node).getServer(b.server.uuid, 3000)).state;
  } catch {
    return null;
  }
}

/** Laatst gemeten schijfgebruik (uit de verbruiksgeschiedenis), als schatting voor de voortgang. */
async function lastDiskBytes(serverId: number): Promise<number | null> {
  const [r] = await getDb().select({ disk: schema.serverStats.diskBytes }).from(schema.serverStats).where(eq(schema.serverStats.serverId, serverId)).orderBy(desc(schema.serverStats.bucket)).limit(1);
  return r?.disk ?? null;
}

// ---------- procedures ----------

type P = Pick<Implementation["servers"], "cloneOptions" | "clone" | "cloneJob" | "clones" | "cancelClone">;

/** Bron of doel mag beheren (eigenaar/volledige admin). */
async function jobFor(ctx: Ctx, id: number): Promise<Row> {
  const [r] = await getDb().select().from(schema.serverClones).where(eq(schema.serverClones.id, id));
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "JOB_NOT_FOUND" });
  const full = isFullAdmin(ctx);
  const uid = ctx.session!.userId;
  if (!full && r.userId !== uid) {
    const ids = [r.sourceServerId, r.targetServerId].filter((x): x is number => x !== null);
    const owned = ids.length ? await getDb().select({ id: schema.servers.id }).from(schema.servers).where(and(inArray(schema.servers.id, ids), eq(schema.servers.ownerId, uid))) : [];
    if (!owned.length) throw new TRPCError({ code: "NOT_FOUND", message: "JOB_NOT_FOUND" });
  }
  if (r.status === "running") {
    await reapStaleClones({ serverId: (r.targetServerId ?? r.sourceServerId) ?? -1 });
    const [again] = await getDb().select().from(schema.serverClones).where(eq(schema.serverClones.id, id));
    return again!;
  }
  return r;
}

export const cloneProcedures: P = {
  cloneOptions: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const a = await requireServer(ctx, input.uuid, "owner");
    const src = a.bundle;
    const p = await plan(src);
    const admin = isFullAdmin(ctx);
    const db = getDb();
    let quota: CloneOptions["quota"] = null;
    let allowed = admin;
    if (!admin) {
      const [q] = await db.select().from(schema.userQuotas).where(eq(schema.userQuotas.userId, src.server.ownerId));
      if (q) {
        const used = (await usageFor(db, [src.server.ownerId])).get(src.server.ownerId)!;
        quota = { ramMb: q.maxRamMb - used.ramMb, diskMb: q.maxDiskMb - used.diskMb, cpuPct: q.maxCpuPct - used.cpuPct, servers: q.maxServers - used.servers, databases: q.maxDatabases - used.databases };
        allowed = true;
      }
    }
    const [free] = await db.select({ n: count() }).from(schema.allocations).where(and(eq(schema.allocations.nodeId, src.node.id), isNull(schema.allocations.serverId)));
    const state = await liveState(src);
    await reapStaleClones({ serverId: src.server.id });
    const running = await runningFor(src.server.id);
    return {
      type: src.server.type,
      limits: limitsOf(src.server),
      ports: src.server.type === "game" ? Math.max(1, p.javaCount) + (p.oldBedrock ? 1 : 0) : 0,
      databases: [...p.copyable.map((r) => ({ name: r.d.name, copyable: true })), ...p.external.map((name) => ({ name, copyable: false }))],
      quota,
      allowed,
      isAdmin: admin,
      freeAllocations: free?.n ?? 0,
      notes: state === "online" || state === "starting" ? [...p.notes, "live_copy"] : p.notes,
      running: running ? view(running) : null,
    };
  },

  clone: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const a = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    const src = a.bundle;
    const admin = isFullAdmin(ctx);
    if (!admin && (input.ownerId !== undefined || input.nodeId !== undefined || input.allocationIds !== undefined)) throw new TRPCError({ code: "FORBIDDEN", message: "ADMIN_ONLY" });
    const db = getDb();
    await reapStaleClones({ serverId: src.server.id });
    if (await runningFor(src.server.id)) throw new TRPCError({ code: "CONFLICT", message: "CLONE_IN_PROGRESS" });
    if (await cloneTargetBusy(src.server.id)) throw new TRPCError({ code: "CONFLICT", message: "CLONE_IN_PROGRESS" });

    const ownerId = admin ? (input.ownerId ?? src.server.ownerId) : src.server.ownerId;
    const [ownerRow] = await db.select().from(schema.users).where(eq(schema.users.id, ownerId));
    if (!ownerRow || ownerRow.isEmergency) throw bad("OWNER_NOT_FOUND");
    const node: NodeRow = admin && input.nodeId !== undefined ? await nodeById(input.nodeId).catch(() => {
      throw bad("NODE_NOT_FOUND");
    }) : src.node;
    const isWeb = src.server.type === "web";
    if (isWeb && !node.supportsDomains) throw precondition("NODE_HAS_NO_DOMAINS: the target node does not support websites");
    if (!isWeb && input.domain) throw bad("DOMAIN_WEB_ONLY");
    if (isWeb && input.allocationIds?.length) throw bad("WEB_HAS_NO_ALLOCATIONS");
    const domain = isWeb && input.domain ? input.domain.toLowerCase().replace(/^\*\./, "") : null;
    if (domain) {
      const [dup] = await db.select({ id: schema.domains.id }).from(schema.domains).where(eq(schema.domains.hostname, domain));
      if (dup) throw new TRPCError({ code: "CONFLICT", message: "DOMAIN_TAKEN" });
    }

    const p = await plan(src);
    const copyDbs = input.copyDatabases ? p.copyable : [];
    let targetHostId: number | null = null;
    if (copyDbs.length) {
      const h = await defaultHost(node.id).catch(() => null);
      if (!h || !h.daemonManaged || h.nodeId !== node.id) throw precondition(`NO_DATABASE_HOST_ON_TARGET: node ${node.name} has no MariaDB managed by its daemon`);
      targetHostId = h.id;
    }
    const state = await liveState(src);
    if (state === null) await call(() => daemonFor(src.node).getServer(src.server.uuid, 3000)); // gooit DAEMON_UNREACHABLE
    if (state === "installing") throw precondition("SERVER_BUSY: the server is installing");
    if (node.id !== src.node.id) await call(() => daemonFor(node).system(5000));
    const live = state === "online" || state === "starting" || state === "stopping";

    const name = input.name.trim();
    if (!name) throw bad("NAME_EMPTY");
    const limits = input.limits ? { ...input.limits, swapMb: admin ? src.server.swapMb : 0 } : { ...limitsOf(src.server), ...(admin ? {} : { swapMb: 0 }) };
    const javaWanted = isWeb ? 0 : Math.max(1, p.javaCount);
    const ports = javaWanted + (p.oldBedrock ? 1 : 0);
    const uuid = randomUUID();
    const vars = await serverVariables(src.server.id);
    if (p.notes.includes("backend_not_in_network") && FORWARDING_VAR in vars) Object.assign(vars, { [FORWARDING_VAR]: "false", [SECRET_VAR]: "" });
    const [alarm] = await db.select().from(schema.serverAlarms).where(eq(schema.serverAlarms.serverId, src.server.id));

    const { targetId, javaAllocs, bedrock, job } = await db.transaction(async (tx) => {
      if (!admin) {
        const q = await lockQuota(tx, ownerId);
        if (!q) throw new TRPCError({ code: "FORBIDDEN", message: "NO_QUOTA" });
        if (q.templateIds && !q.templateIds.includes(src.template.id)) throw new TRPCError({ code: "FORBIDDEN", message: "TEMPLATE_NOT_ALLOWED" });
        if (q.nodeIds && !q.nodeIds.includes(node.id)) throw new TRPCError({ code: "FORBIDDEN", message: "NODE_NOT_ALLOWED" });
        if (q.maxPortsPerServer !== null && ports > q.maxPortsPerServer) throw exceeded("ports");
        const used = (await usageFor(tx, [ownerId])).get(ownerId)!;
        if (used.servers + 1 > q.maxServers) throw exceeded("servers");
        checkLimits(q, used, limits);
        if (copyDbs.length && used.databases + copyDbs.length > q.maxDatabases) throw exceeded("databases");
      }
      // Poorten: opgegeven (admin) of de eerste vrije; Bedrock op hetzelfde IP als de nieuwe primaire poort.
      let java: Array<typeof schema.allocations.$inferSelect> = [];
      if (javaWanted) {
        if (input.allocationIds?.length) {
          java = await checkAllocations(tx, input.allocationIds, node.id, null);
        } else {
          const free = await tx
            .select()
            .from(schema.allocations)
            .where(and(eq(schema.allocations.nodeId, node.id), isNull(schema.allocations.serverId)))
            .orderBy(asc(schema.allocations.port), asc(schema.allocations.id))
            .for("update", { skipLocked: true });
          const bedrockish = (port: number) => !!p.oldBedrock && (port === p.oldBedrock.port || port === DEFAULT_BEDROCK_PORT);
          java = [...free.filter((f) => !bedrockish(f.port)), ...free.filter((f) => bedrockish(f.port))].slice(0, javaWanted);
          if (java.length < javaWanted) throw precondition(`NO_FREE_ALLOCATIONS: node ${node.name} has ${free.length} free allocation(s), ${ports} needed`);
        }
      }
      let bedrock: typeof schema.allocations.$inferSelect | null = null;
      if (p.oldBedrock && java.length) {
        const ids = java.map((j) => j.id);
        const free = (await tx.select().from(schema.allocations).where(and(eq(schema.allocations.nodeId, node.id), isNull(schema.allocations.serverId), eq(schema.allocations.ip, java[0]!.ip))).orderBy(asc(schema.allocations.port))).filter((f) => !ids.includes(f.id));
        bedrock = free.find((f) => f.port === DEFAULT_BEDROCK_PORT) ?? free[0] ?? null;
        if (!bedrock) throw precondition(`NO_FREE_ALLOCATIONS: Bedrock is on, but node ${node.name} has no free allocation on ${java[0]!.ip} for it`);
      }
      const [srv] = await tx
        .insert(schema.servers)
        .values({
          uuid,
          name,
          ownerId,
          nodeId: node.id,
          templateId: src.template.id,
          type: src.server.type,
          cpuPct: limits.cpuPct,
          ramMb: limits.ramMb,
          swapMb: limits.swapMb,
          diskMb: limits.diskMb,
          sleepEnabled: src.server.sleepEnabled,
          sleepIdleMinutes: src.server.sleepIdleMinutes,
          imageUpdatePolicy: src.server.imageUpdatePolicy,
          autoRestart: src.server.autoRestart,
          autoRestartMax: src.server.autoRestartMax,
          domainsAllowed: src.server.domainsAllowed && node.supportsDomains,
          bedrockAllocationId: bedrock?.id ?? null,
          status: "installing",
        })
        .returning({ id: schema.servers.id });
      const all = [...java.map((j) => j.id), ...(bedrock ? [bedrock.id] : [])];
      if (all.length) await assignAllocations(tx, srv!.id, all);
      const entries = Object.entries(vars);
      if (entries.length) await tx.insert(schema.serverVariables).values(entries.map(([key, value]) => ({ serverId: srv!.id, key, value })));
      if (alarm) await tx.insert(schema.serverAlarms).values({ ...alarm, serverId: srv!.id, updatedAt: new Date() });
      const steps: Step[] = [
        { key: "create", status: "pending" },
        { key: "files", status: "pending" },
        { key: "databases", status: copyDbs.length ? "pending" : "skipped" },
        { key: "domain", status: domain ? "pending" : "skipped" },
        { key: "finish", status: "pending" },
      ];
      const warnings: string[] = [];
      if (input.copyDatabases && p.external.length) warnings.push(`Databases on external hosts were not copied: ${p.external.join(", ")}`);
      const [job] = await tx
        .insert(schema.serverClones)
        .values({
          sourceServerId: src.server.id,
          targetServerId: srv!.id,
          sourceUuid: src.server.uuid,
          targetUuid: uuid,
          sourceName: src.server.name,
          targetName: name,
          userId: ctx.session!.userId,
          steps,
          options: { copyDatabases: copyDbs.length > 0, domain, startAfter: input.startAfter, sameNode: node.id === src.node.id, live },
          warnings,
        })
        .returning();
      return { targetId: srv!.id, javaAllocs: java, bedrock, job: job! };
    });

    const meta = { cloneId: job.id, sourceUuid: src.server.uuid, targetUuid: uuid, targetName: name, nodeId: node.id, ownerId, limits, ports: [...javaAllocs.map((x) => x.port), ...(bedrock ? [bedrock.port] : [])], copyDatabases: copyDbs.map((r) => r.d.name), domain, live };
    await logActivity({ action: "server.clone.start", userId: ctx.session!.userId, serverId: src.server.id, metadata: meta, ip: ctx.ip, ctx });
    await logActivity({ action: "server.clone.created", userId: ctx.session!.userId, serverId: targetId, metadata: meta, ip: ctx.ip, ctx });

    const ac = new AbortController();
    active.set(job.id, ac);
    void runClone({ ctx, job, src, node, targetHostId, copyDbs, javaAllocs, bedrock, ac }).finally(() => active.delete(job.id));
    return view(job);
  },

  cloneJob: async ({ input, ctx }) => view(await jobFor(ctx, input.id)),

  clones: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner");
    await reapStaleClones({ serverId: a.bundle.server.id });
    const rows = await getDb()
      .select()
      .from(schema.serverClones)
      .where(or(eq(schema.serverClones.sourceServerId, a.bundle.server.id), eq(schema.serverClones.targetServerId, a.bundle.server.id)))
      .orderBy(desc(schema.serverClones.id))
      .limit(10);
    return rows.map(view);
  },

  cancelClone: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const r = await jobFor(ctx, input.id);
    if (r.status !== "running") throw new TRPCError({ code: "CONFLICT", message: "CLONE_NOT_RUNNING" });
    await getDb().update(schema.serverClones).set({ cancelRequested: true }).where(eq(schema.serverClones.id, r.id));
    active.get(r.id)?.abort();
    await logActivity({ action: "server.clone.cancel", userId: ctx.session!.userId, serverId: r.sourceServerId, metadata: { cloneId: r.id, targetUuid: r.targetUuid }, ip: ctx.ip, ctx });
    return { ok: true as const };
  },
};

// ---------- uitvoeren ----------

interface RunInput {
  ctx: Ctx;
  job: Row;
  src: ServerBundle;
  node: NodeRow;
  targetHostId: number | null;
  copyDbs: Plan["copyable"];
  javaAllocs: Array<typeof schema.allocations.$inferSelect>;
  bedrock: typeof schema.allocations.$inferSelect | null;
  ac: AbortController;
}

/** Telt de bytes die door de stroom gaan en schrijft ze zo nu en dan weg. */
function counting(stream: ReadableStream<Uint8Array>, onBytes: (n: number) => void): ReadableStream<Uint8Array> {
  let n = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        n += chunk.byteLength;
        onBytes(n);
        c.enqueue(chunk);
      },
    }),
  );
}

async function waitStopped(d: DaemonClient, uuid: string, signal: AbortSignal): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const s = await call(() => d.getServer(uuid));
    if (s.state === "offline" || s.state === "install_failed" || s.state === "sleeping") return;
    if (signal.aborted) throw new Canceled();
    if (Date.now() - t0 > cloneTiming.stateWaitMs) throw precondition(`CLONE_TARGET_NOT_READY: new server stays ${s.state}`);
    await sleep(cloneTiming.pollMs);
  }
}

export async function runClone(r: RunInput): Promise<void> {
  const db = getDb();
  const { ctx, job, src, node, ac } = r;
  const steps = job.steps.map((s) => ({ ...s }));
  const warnings = [...job.warnings];
  const copied: Row["databases"] = [];
  const srcD = daemonFor(src.node);
  const dstD = daemonFor(node);
  const uuid = job.targetUuid;
  const save = (extra: Partial<typeof schema.serverClones.$inferInsert> = {}) =>
    db.update(schema.serverClones).set({ steps: steps.map((s) => ({ ...s })), warnings: [...warnings], databases: [...copied], ...extra }).where(eq(schema.serverClones.id, job.id));
  const set = async (key: CloneStepKey, status: Step["status"]) => {
    const s = steps.find((x) => x.key === key);
    if (s) s.status = status;
    await save();
  };
  const checkCancel = async () => {
    if (ac.signal.aborted) throw new Canceled();
    const [row] = await db.select({ c: schema.serverClones.cancelRequested }).from(schema.serverClones).where(eq(schema.serverClones.id, job.id));
    if (row?.c) {
      ac.abort();
      throw new Canceled();
    }
  };
  let frozen = false;
  try {
    // 1. Server op de doelnode (zonder installatie: de bestanden komen van de bron).
    await set("create", "running");
    const vars = await serverVariables(job.targetServerId!);
    const spec = buildServerSpec({
      uuid,
      template: src.template,
      variables: vars,
      limits: await targetLimits(job.targetServerId!),
      allocations: r.javaAllocs.concat(r.bedrock ? [r.bedrock] : []).map((a, i) => ({ ip: a.ip, port: a.port, isPrimary: i === 0 })),
      skipInstall: true,
      startOnInstall: false,
      sleep: { ...sleepOf(src.server), name: job.targetName },
      autoRestart: autoRestartOf(src.server),
      imagePolicy: imagePolicyOf(src.server),
    });
    await call(() => dstD.createServer(spec));
    await waitStopped(dstD, uuid, ac.signal);
    await set("create", "done");
    await checkCancel();

    // 2. Bestanden.
    await set("files", "running");
    const total = await lastDiskBytes(src.server.id);
    if (total !== null) await save({ bytesTotal: total });
    const state = await liveState(src);
    const live = state === "online" || state === "starting" || state === "stopping";
    frozen = live ? await freezeWorld(src) : false;
    let last = 0;
    let lastBytes = 0;
    const progress = (n: number) => {
      lastBytes = n;
      if (Date.now() - last < cloneTiming.progressMs) return;
      last = Date.now();
      void db.update(schema.serverClones).set({ bytesCopied: n }).where(eq(schema.serverClones.id, job.id)).catch(() => undefined);
    };
    const stream = async () => dstD.importData(uuid, counting(await srcD.exportData(src.server.uuid, { live, signal: ac.signal }), progress), { signal: ac.signal });
    try {
      if (node.id === src.node.id) {
        try {
          await dstD.copyData(uuid, src.server.uuid, { live, signal: ac.signal });
        } catch (e) {
          if (!(e instanceof DaemonHttpError && e.status === 404 && /unknown path/i.test(e.message))) throw toTrpcError(e);
          await call(stream); // oudere daemon: via het panel
        }
      } else {
        await call(stream);
      }
    } catch (e) {
      if (ac.signal.aborted) throw new Canceled();
      throw e;
    } finally {
      if (frozen) await thawWorld(src);
      frozen = false;
    }
    await save({ bytesCopied: lastBytes || (total ?? 0), options: { ...job.options, live } });
    // Bedrock: Geyser luistert op de nieuwe UDP-poort en praat met de nieuwe Java-poort.
    const platform = src.server.type === "game" ? bedrockPlatform(src.template.slug) : null;
    if (r.bedrock && platform && r.javaAllocs[0]) {
      try {
        await dstD.writeFile(uuid, geyserConfigPath(platform), geyserConfig({ port: r.bedrock.port, javaPort: r.javaAllocs[0].port }));
      } catch (e) {
        warnings.push(`Writing the Geyser config failed: ${errText(e)}`);
      }
    }
    await set("files", "done");
    await checkCancel();

    // 3. Databases: nieuwe naam en gebruiker, dump → import.
    if (r.copyDbs.length) {
      await set("databases", "running");
      const target = await fetchServerByUuid(uuid);
      if (!target) throw new Error("new server disappeared");
      const access = await accessFor(ctx, target);
      for (const s of r.copyDbs) {
        await checkCancel();
        const base = s.d.name.replace(/^s[0-9a-f]{8}_/, "").slice(0, 40) || "db";
        let created: Awaited<ReturnType<typeof createServerDatabase>> | null = null;
        for (let i = 1; i <= 5 && !created; i++) {
          try {
            created = await createServerDatabase(ctx, access, uuid, i === 1 ? base : `${base}_${i}`, r.targetHostId);
          } catch (e) {
            if (!(e instanceof TRPCError && e.message === "DATABASE_EXISTS") || i === 5) throw e;
          }
        }
        copied.push({ from: s.d.name, to: created!.name, username: created!.username });
        await save();
        const sd = s.h.nodeId === src.node.id ? srcD : daemonFor(await nodeById(s.h.nodeId!));
        await call(async () => dstD.dbImport(created!.name, await sd.dbDump(s.d.name, { signal: ac.signal }), { signal: ac.signal }));
      }
      await set("databases", "done");
      await checkCancel();
    }

    // 4. Domein (website): via de gewone domains.add (rechten, route, relay). Mislukt het, dan een waarschuwing.
    const domain = job.options.domain;
    if (domain) {
      await set("domain", "running");
      try {
        await domainProcs.add({ input: { uuid, hostname: domain, protocol: "http", targetPort: null, redirectTo: null, wildcard: false, dnsProviderId: null }, ctx } as never);
        await set("domain", "done");
      } catch (e) {
        warnings.push(`Adding the domain ${domain} failed: ${errText(e)}`);
        await set("domain", "failed");
      }
    }

    // 5. Klaar: status, eventueel starten, melding.
    await set("finish", "running");
    await checkCancel();
    await db.update(schema.servers).set({ status: "offline", installedAt: new Date() }).where(eq(schema.servers.uuid, uuid));
    if (job.options.startAfter) {
      try {
        await dstD.power(uuid, "start");
        await db.update(schema.servers).set({ status: "starting" }).where(eq(schema.servers.uuid, uuid));
      } catch (e) {
        warnings.push(`Starting the new server failed: ${errText(e)}`);
      }
    }
    if (isProxy(src)) warnings.push("The proxy's network members were not cloned; add backends on the Network tab.");
    if (copied.length) warnings.push("Configuration files still point to the original database(s); update them to the new names.");
    steps.find((s) => s.key === "finish")!.status = "done";
    await save({ status: "succeeded", finishedAt: new Date() });
    await logActivity({ action: "server.clone.complete", userId: job.userId, serverId: job.targetServerId, metadata: { cloneId: job.id, sourceUuid: src.server.uuid, databases: copied, warnings } });
    await notifyClone(job, "succeeded", null);
  } catch (e) {
    if (frozen) await thawWorld(src).catch(() => undefined);
    const canceled = e instanceof Canceled || ac.signal.aborted;
    for (const s of steps) if (s.status === "running") s.status = canceled ? "skipped" : "failed";
    for (const s of steps) if (s.status === "pending") s.status = "skipped";
    const code = canceled ? "CANCELED" : e instanceof TRPCError ? e.message.split(":")[0]!.trim() : "CLONE_FAILED";
    try {
      await removeTarget(uuid);
    } catch (err) {
      warnings.push(`Removing the partial copy failed: ${errText(err)}`);
    }
    await save({ status: canceled ? "canceled" : "failed", errorCode: code, error: canceled ? null : errText(e), finishedAt: new Date() }).catch(() => undefined);
    await logActivity({ action: canceled ? "server.clone.canceled" : "server.clone.failed", userId: job.userId, serverId: src.server.id, metadata: { cloneId: job.id, targetUuid: uuid, error: canceled ? null : errText(e) } });
    if (!canceled) await notifyClone(job, "failed", errText(e));
  }
}

async function targetLimits(serverId: number) {
  const [s] = await getDb().select().from(schema.servers).where(eq(schema.servers.id, serverId));
  if (!s) throw new Error("new server disappeared");
  return { cpuPct: s.cpuPct, ramMb: s.ramMb, swapMb: s.swapMb, diskMb: s.diskMb };
}

/** Melding aan wie de kopie startte en de (nieuwe) eigenaar, volgens hun voorkeuren. */
async function notifyClone(job: Row, result: "succeeded" | "failed", error: string | null): Promise<void> {
  const [t] = await getDb().select({ ownerId: schema.servers.ownerId }).from(schema.servers).where(eq(schema.servers.uuid, job.targetUuid));
  const users = [...new Set([job.userId, t?.ownerId].filter((x): x is number => typeof x === "number"))];
  if (!users.length) return;
  const server = result === "succeeded" ? { uuid: job.targetUuid, name: job.targetName } : { uuid: job.sourceUuid, name: job.sourceName };
  await notify({ kind: "server_cloned", result, sourceName: job.sourceName, targetName: job.targetName, error }, { server, hooks: [], admin: false, users });
}
