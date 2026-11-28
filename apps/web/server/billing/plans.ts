/** Pakketten: validatie, mapping en de limieten die voor een pakketserver gelden. */
import type { Plan, PlanInput } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, count, eq, inArray, ne } from "drizzle-orm";
import { getDb, schema, type Db } from "../db";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type PlanRow = typeof schema.plans.$inferSelect;

const invalid = (what: string) => new TRPCError({ code: "BAD_REQUEST", message: `PLAN_INVALID: ${what}` });

/** Regels die zod niet uitdrukt. Gooit BAD_REQUEST `PLAN_INVALID: <veld>`. */
export async function validatePlan(p: PlanInput): Promise<void> {
  if (p.type === "game" && p.allocations < 1) throw invalid("allocations");
  if (p.type === "web" && p.allocations !== 0) throw invalid("allocations");
  if (new Set(p.templateIds).size !== p.templateIds.length) throw invalid("templateIds");
  const db = getDb();
  const tpls = await db.select({ id: schema.templates.id, type: schema.templates.type }).from(schema.templates).where(inArray(schema.templates.id, p.templateIds));
  if (tpls.length !== p.templateIds.length) throw invalid("templateIds");
  if (tpls.some((t) => t.type !== p.type)) throw invalid("templateIds");
  if (p.nodeIds) {
    if (new Set(p.nodeIds).size !== p.nodeIds.length) throw invalid("nodeIds");
    const nodes = await db.select({ id: schema.nodes.id, supportsDomains: schema.nodes.supportsDomains }).from(schema.nodes).where(inArray(schema.nodes.id, p.nodeIds));
    if (nodes.length !== p.nodeIds.length) throw invalid("nodeIds");
    if (p.type === "web" && !nodes.some((n) => n.supportsDomains)) throw invalid("nodeIds");
  }
}

export async function toPlans(rows: PlanRow[]): Promise<Plan[]> {
  if (!rows.length) return [];
  const db = getDb();
  const ids = [...new Set(rows.flatMap((r) => r.templateIds))];
  const tpls = ids.length ? await db.select({ id: schema.templates.id, name: schema.templates.name }).from(schema.templates).where(inArray(schema.templates.id, ids)) : [];
  const names = new Map(tpls.map((t) => [t.id, t.name]));
  const counts = await db
    .select({ planId: schema.subscriptions.planId, n: count() })
    .from(schema.subscriptions)
    .where(and(inArray(schema.subscriptions.planId, rows.map((r) => r.id)), ne(schema.subscriptions.status, "canceled")))
    .groupBy(schema.subscriptions.planId);
  const active = new Map(counts.map((c) => [c.planId, c.n]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    type: r.type,
    templateIds: r.templateIds,
    nodeIds: r.nodeIds,
    ramMb: r.ramMb,
    cpuPct: r.cpuPct,
    diskMb: r.diskMb,
    maxDatabases: r.maxDatabases,
    maxBackups: r.maxBackups,
    allocations: r.allocations,
    priceCents: r.priceCents,
    currency: r.currency,
    visible: r.visible,
    sortOrder: r.sortOrder,
    // Verwijderde templates vallen weg.
    templates: r.templateIds.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! })),
    activeSubscriptions: active.get(r.id) ?? 0,
  }));
}

/** Pakket van een server (via een niet-beëindigd abonnement), of null. */
export async function planForServer(db: Db | Tx, serverId: number): Promise<PlanRow | null> {
  const [r] = await db
    .select({ plan: schema.plans })
    .from(schema.subscriptions)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
    .where(eq(schema.subscriptions.serverId, serverId));
  return r?.plan ?? null;
}

const planLimit = (what: string) => new TRPCError({ code: "PRECONDITION_FAILED", message: `PLAN_LIMIT: ${what}` });

/** Pakketserver: maximaal `maxDatabases` databases. Binnen een transactie aanroepen (de serverrij wordt vergrendeld). */
export async function assertPlanDatabaseRoom(tx: Tx, serverId: number): Promise<boolean> {
  const plan = await planForServer(tx, serverId);
  if (!plan) return false;
  await tx.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.id, serverId)).for("update");
  const [c] = await tx.select({ n: count() }).from(schema.databases).where(eq(schema.databases.serverId, serverId));
  if ((c?.n ?? 0) + 1 > plan.maxDatabases) throw planLimit("databases");
  return true;
}

/** Pakketserver: maximaal `maxBackups` bewaarde backups (mislukte tellen niet). */
export async function assertPlanBackupRoom(serverId: number): Promise<void> {
  const db = getDb();
  const plan = await planForServer(db, serverId);
  if (!plan) return;
  const [c] = await db.select({ n: count() }).from(schema.backups).where(and(eq(schema.backups.serverId, serverId), ne(schema.backups.status, "failed")));
  if ((c?.n ?? 0) + 1 > plan.maxBackups) throw planLimit("backups");
}
