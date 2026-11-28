/**
 * Kern van pakketten en facturatie: server aanmaken voor een pakket (node-keuze), facturen,
 * betalingen verwerken, opschorten/opheffen en de maandelijkse cyclus (`billingTick`).
 *
 * Cyclus (elke scheduler-tik, idempotent en veilig met meerdere panelprocessen):
 * 1. abonnementen zonder server → beëindigd
 * 2. nooit betaald (eerste factuur verlopen) → beëindigd, server verwijderd, factuur vervallen
 * 3. opgezegd en periode voorbij → beëindigd, server opgeschort (`SUBSCRIPTION_ENDED`)
 * 4. (facturatie aan) periode voorbij → nieuwe factuur (vervalt aan het begin van de nieuwe periode)
 * 5. (facturatie aan) open factuur over de vervaldatum → achterstallig, abonnement past_due
 * 6. (facturatie aan) past_due ≥ suspendAfterDays → server stoppen + opschorten (`BILLING_OVERDUE`)
 * 7. deleteAfterDays ingesteld: opgeschort ≥ zoveel dagen achterstand, of zoveel dagen na beëindiging → server verwijderen
 */
import { randomUUID } from "node:crypto";
import type { Ctx, Invoice, InvoiceDetail, Subscription } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { logActivity } from "../activity";
import { DaemonHttpError, call, daemonFor } from "../daemon";
import { getDb, schema, type Db } from "../db";
import { getEnv } from "../env";
import { buildServerSpec, validateVariables } from "../spec";
import { fetchServerByUuid, userPublic } from "../servers-data";
import { deleteServerFully } from "../routers/admin";
import type { PlanRow } from "./plans";
import { ProviderError, providerFor } from "./providers";
import { billingActive, getBillingConfig, type BillingConfig } from "./settings";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SubRow = typeof schema.subscriptions.$inferSelect;
type InvRow = typeof schema.invoices.$inferSelect;

export const DAY_MS = 86_400_000;
/** Zo lang heeft een nieuwe gebruiker om de eerste factuur te betalen; daarna wordt het abonnement opgeruimd. */
export const FIRST_INVOICE_DAYS = 2;
/** Redenen van opschorting die de facturatie zelf zet (en dus ook weer opheft). */
export const BILLING_REASONS = ["BILLING_UNPAID", "BILLING_OVERDUE", "SUBSCRIPTION_ENDED"] as const;
const PROVISION_LOCK = 0x6269_6c6c; // "bill"

// ---------- klok (tests zetten een nepklok) ----------

let clock: () => Date = () => new Date();
export const billingNow = () => clock();
export function setBillingClock(fn: (() => Date) | null): void {
  clock = fn ?? (() => new Date());
}

// ---------- datums en nummers ----------

/** `months` maanden later op dag `anchorDay` (geknipt op het einde van korte maanden), zelfde tijd (UTC). */
export function addMonths(d: Date, months: number, anchorDay = d.getUTCDate()): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(anchorDay, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

const yearIn = (d: Date) => Number(new Intl.DateTimeFormat("en", { timeZone: "Europe/Amsterdam", year: "numeric" }).format(d));

/** Doorlopend nummer per jaar: `<prefix><jaar>-<0001>`. Atomair (upsert op invoice_sequences). */
export async function nextInvoiceNumber(tx: Tx, prefix: string, now: Date): Promise<string> {
  const year = yearIn(now);
  const [r] = await tx
    .insert(schema.invoiceSequences)
    .values({ year, last: 1 })
    .onConflictDoUpdate({ target: schema.invoiceSequences.year, set: { last: sql`${schema.invoiceSequences.last} + 1` } })
    .returning({ last: schema.invoiceSequences.last });
  return `${prefix}${year}-${String(r!.last).padStart(4, "0")}`;
}

async function issueInvoice(
  tx: Tx,
  cfg: BillingConfig,
  o: { sub: SubRow; description: string; periodStart: Date | null; periodEnd: Date | null; dueAt: Date; now: Date },
): Promise<InvRow> {
  const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, o.sub.userId));
  const [inv] = await tx
    .insert(schema.invoices)
    .values({
      number: await nextInvoiceNumber(tx, cfg.invoicePrefix, o.now),
      userId: o.sub.userId,
      subscriptionId: o.sub.id,
      description: o.description,
      amountCents: o.sub.priceCents,
      currency: o.sub.currency,
      status: "open",
      periodStart: o.periodStart,
      periodEnd: o.periodEnd,
      issuedAt: o.now,
      dueAt: o.dueAt,
      customerName: u?.name ?? null,
      customerDiscordId: u?.discordId ?? null,
    })
    .returning();
  return inv!;
}

// ---------- mapping ----------

const owner = alias(schema.users, "sub_owner");

export async function fetchSubscriptions(where: SQL | undefined, opts: { limit?: number } = {}): Promise<Subscription[]> {
  let q = getDb()
    .select({ s: schema.subscriptions, u: owner, p: { id: schema.plans.id, name: schema.plans.name, type: schema.plans.type }, srv: { uuid: schema.servers.uuid, name: schema.servers.name } })
    .from(schema.subscriptions)
    .innerJoin(owner, eq(owner.id, schema.subscriptions.userId))
    .innerJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
    .leftJoin(schema.servers, eq(schema.servers.id, schema.subscriptions.serverId))
    .where(where)
    .orderBy(sql`${schema.subscriptions.id} desc`)
    .$dynamic();
  if (opts.limit) q = q.limit(opts.limit);
  const rows = await q;
  return rows.map((r) => ({
    id: r.s.id,
    user: userPublic(r.u),
    plan: r.p,
    server: r.srv?.uuid ? { uuid: r.srv.uuid, name: r.srv.name } : null,
    status: r.s.status,
    free: r.s.free,
    priceCents: r.s.priceCents,
    currency: r.s.currency,
    cancelAtPeriodEnd: r.s.cancelAtPeriodEnd,
    currentPeriodStart: r.s.currentPeriodStart,
    currentPeriodEnd: r.s.currentPeriodEnd,
    pastDueSince: r.s.pastDueSince,
    canceledAt: r.s.canceledAt,
    createdAt: r.s.createdAt,
  }));
}

export async function subscriptionById(id: number): Promise<Subscription> {
  const [s] = await fetchSubscriptions(eq(schema.subscriptions.id, id));
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "SUBSCRIPTION_NOT_FOUND" });
  return s;
}

const invOwner = alias(schema.users, "inv_owner");

export async function fetchInvoices(where: SQL | undefined, limit?: number): Promise<Invoice[]> {
  let q = getDb().select({ i: schema.invoices, u: invOwner }).from(schema.invoices).innerJoin(invOwner, eq(invOwner.id, schema.invoices.userId)).where(where).orderBy(sql`${schema.invoices.id} desc`).$dynamic();
  if (limit) q = q.limit(limit);
  return (await q).map(({ i, u }) => toInvoice(i, u));
}

export function toInvoice(i: InvRow, u: typeof schema.users.$inferSelect): Invoice {
  return {
    id: i.id,
    number: i.number,
    user: userPublic(u),
    subscriptionId: i.subscriptionId,
    description: i.description,
    amountCents: i.amountCents,
    currency: i.currency,
    status: i.status,
    periodStart: i.periodStart,
    periodEnd: i.periodEnd,
    issuedAt: i.issuedAt,
    dueAt: i.dueAt,
    paidAt: i.paidAt,
    provider: i.provider,
  };
}

export async function invoiceDetail(id: number, viewer: { userId: number; fullAdmin: boolean }): Promise<InvoiceDetail> {
  const [r] = await getDb().select({ i: schema.invoices, u: invOwner }).from(schema.invoices).innerJoin(invOwner, eq(invOwner.id, schema.invoices.userId)).where(eq(schema.invoices.id, id));
  if (!r || (r.i.userId !== viewer.userId && !viewer.fullAdmin)) throw new TRPCError({ code: "NOT_FOUND", message: "INVOICE_NOT_FOUND" });
  const cfg = await getBillingConfig();
  return {
    ...toInvoice(r.i, r.u),
    issuer: cfg.issuer,
    customer: { name: r.i.customerName ?? r.u.name, discordId: r.i.customerDiscordId ?? r.u.discordId },
    lines: [{ description: r.i.description, quantity: 1, unitCents: r.i.amountCents, totalCents: r.i.amountCents }],
    canPay: r.i.userId === viewer.userId && billingActive(cfg) && (r.i.status === "open" || r.i.status === "overdue"),
  };
}

// ---------- node-keuze en aanmaken ----------

export interface NodeChoice {
  node: typeof schema.nodes.$inferSelect;
  allocations: Array<typeof schema.allocations.$inferSelect>;
}

/**
 * Kiest de node voor een pakketserver: binnen `plan.nodeIds` (of alle nodes), websites alleen op nodes met
 * domeinen, genoeg vrije RAM en disk (maxRamMb/maxDiskMb 0 = onbeperkt) en genoeg vrije poorten.
 * Voorkeur: de meeste vrije RAM (onbeperkt eerst), dan het laagste id. Vergrendelt de gekozen poorten.
 * Moet binnen de provisioning-lock draaien (zie provisionPlanServer).
 */
export async function pickNode(tx: Tx, plan: Pick<PlanRow, "type" | "nodeIds" | "ramMb" | "diskMb" | "allocations">): Promise<NodeChoice> {
  const conds: SQL[] = [];
  if (plan.nodeIds) conds.push(inArray(schema.nodes.id, plan.nodeIds.length ? plan.nodeIds : [-1]));
  if (plan.type === "web") conds.push(eq(schema.nodes.supportsDomains, true));
  // Nodes die nog via join worden opgezet, niet gebruiken.
  conds.push(or(isNull(schema.nodes.joinState), eq(schema.nodes.joinState, "ready"))!);
  const nodes = await tx.select().from(schema.nodes).where(and(...conds)).orderBy(asc(schema.nodes.id));
  if (!nodes.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_CAPACITY" });
  const ids = nodes.map((n) => n.id);
  const used = await tx
    .select({ nodeId: schema.servers.nodeId, ram: sql<number>`coalesce(sum(${schema.servers.ramMb}), 0)::int`, disk: sql<number>`coalesce(sum(${schema.servers.diskMb}), 0)::int` })
    .from(schema.servers)
    .where(inArray(schema.servers.nodeId, ids))
    .groupBy(schema.servers.nodeId);
  const free = await tx
    .select({ nodeId: schema.allocations.nodeId, n: sql<number>`count(*)::int` })
    .from(schema.allocations)
    .where(and(inArray(schema.allocations.nodeId, ids), isNull(schema.allocations.serverId)))
    .groupBy(schema.allocations.nodeId);
  const u = new Map(used.map((r) => [r.nodeId, r]));
  const f = new Map(free.map((r) => [r.nodeId, r.n]));
  const room = (max: number, usedMb: number, want: number) => (max === 0 ? Number.POSITIVE_INFINITY : max - usedMb - want);
  const fits = nodes
    .map((n) => ({ n, ram: room(n.maxRamMb, u.get(n.id)?.ram ?? 0, plan.ramMb), disk: room(n.maxDiskMb, u.get(n.id)?.disk ?? 0, plan.diskMb), ports: f.get(n.id) ?? 0 }))
    .filter((c) => c.ram >= 0 && c.disk >= 0 && c.ports >= plan.allocations)
    .sort((a, b) => b.ram - a.ram || a.n.id - b.n.id);
  for (const c of fits) {
    if (!plan.allocations) return { node: c.n, allocations: [] };
    const picked = await tx
      .select()
      .from(schema.allocations)
      .where(and(eq(schema.allocations.nodeId, c.n.id), isNull(schema.allocations.serverId)))
      .orderBy(asc(schema.allocations.port), asc(schema.allocations.id))
      .limit(plan.allocations)
      .for("update", { skipLocked: true });
    if (picked.length === plan.allocations) return { node: c.n, allocations: picked };
  }
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_CAPACITY" });
}

export interface ProvisionInput {
  userId: number;
  plan: PlanRow;
  templateId: number;
  name: string;
  variables: Record<string, string>;
  /** true: met facturen (eerste factuur open, server opgeschort tot betaald). */
  paid: boolean;
  /** Door een admin toegekend (mag alle variabelen zetten). */
  grantedBy: number | null;
  ctx: Ctx;
}

export interface ProvisionResult {
  subscriptionId: number;
  serverUuid: string;
  invoiceId: number | null;
}

/** Maakt abonnement + server (+ eerste factuur). Atomair; bij een daemonfout wordt alles teruggedraaid. */
export async function provisionPlanServer(i: ProvisionInput): Promise<ProvisionResult> {
  const db = getDb();
  const { plan } = i;
  if (!plan.templateIds.includes(i.templateId)) throw new TRPCError({ code: "FORBIDDEN", message: "TEMPLATE_NOT_ALLOWED" });
  const [template] = await db.select().from(schema.templates).where(eq(schema.templates.id, i.templateId));
  if (!template || template.type !== plan.type) throw new TRPCError({ code: "FORBIDDEN", message: "TEMPLATE_NOT_ALLOWED" });
  const errors = validateVariables(template.variables, i.variables, { onlyUserEditable: i.grantedBy === null });
  if (errors.length) throw new TRPCError({ code: "BAD_REQUEST", message: `INVALID_VARIABLES: ${errors.join("; ")}` });
  const name = i.name.trim();
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "NAME_EMPTY" });
  const cfg = await getBillingConfig();
  const now = billingNow();
  const limits = { cpuPct: plan.cpuPct, ramMb: plan.ramMb, swapMb: 0, diskMb: plan.diskMb };
  const uuid = randomUUID();

  const r = await db.transaction(async (tx) => {
    // Eén provisioning tegelijk: de capaciteitscontrole en de reservering horen bij elkaar.
    await tx.execute(sql`select pg_advisory_xact_lock(${PROVISION_LOCK})`);
    const choice = await pickNode(tx, plan);
    const [srv] = await tx
      .insert(schema.servers)
      .values({
        uuid,
        name,
        ownerId: i.userId,
        nodeId: choice.node.id,
        templateId: template.id,
        type: template.type,
        ...limits,
        status: "installing",
        ...(i.paid ? { suspendedAt: now, suspendedReason: "BILLING_UNPAID" } : {}),
      })
      .returning({ id: schema.servers.id });
    for (const [idx, a] of choice.allocations.entries()) await tx.update(schema.allocations).set({ serverId: srv!.id, isPrimary: idx === 0 }).where(eq(schema.allocations.id, a.id));
    const vars = Object.entries(i.variables);
    if (vars.length) await tx.insert(schema.serverVariables).values(vars.map(([key, value]) => ({ serverId: srv!.id, key, value })));
    const [sub] = await tx
      .insert(schema.subscriptions)
      .values({
        userId: i.userId,
        planId: plan.id,
        serverId: srv!.id,
        status: i.paid ? "pending" : "active",
        free: !i.paid,
        priceCents: i.paid ? plan.priceCents : 0,
        currency: plan.currency,
        currentPeriodStart: i.paid ? null : now,
        grantedBy: i.grantedBy,
        createdAt: now,
      })
      .returning();
    let invoiceId: number | null = null;
    if (i.paid) {
      const inv = await issueInvoice(tx, cfg, { sub: sub!, description: `${plan.name} (${name})`, periodStart: null, periodEnd: null, dueAt: new Date(now.getTime() + FIRST_INVOICE_DAYS * DAY_MS), now });
      invoiceId = inv.id;
    }
    return { serverId: srv!.id, subscriptionId: sub!.id, invoiceId, choice };
  });

  const spec = buildServerSpec({
    uuid,
    template,
    variables: i.variables,
    limits,
    allocations: r.choice.allocations.map((a, idx) => ({ ip: a.ip, port: a.port, isPrimary: idx === 0 })),
    startOnInstall: !i.paid,
  });
  try {
    await call(() => daemonFor(r.choice.node).createServer(spec));
  } catch (e) {
    await db.transaction(async (tx) => {
      if (r.invoiceId) await tx.delete(schema.invoices).where(eq(schema.invoices.id, r.invoiceId));
      await tx.delete(schema.subscriptions).where(eq(schema.subscriptions.id, r.subscriptionId));
      await tx.update(schema.allocations).set({ serverId: null, isPrimary: false }).where(eq(schema.allocations.serverId, r.serverId));
      await tx.delete(schema.servers).where(eq(schema.servers.id, r.serverId));
    });
    throw e;
  }
  await logActivity({
    action: i.grantedBy ? "admin.subscription.grant" : "billing.subscribe",
    userId: i.grantedBy ?? i.userId,
    serverId: r.serverId,
    metadata: { subscriptionId: r.subscriptionId, planId: plan.id, plan: plan.name, serverUuid: uuid, serverName: name, nodeId: r.choice.node.id, targetUserId: i.userId, paid: i.paid, ports: r.choice.allocations.map((a) => a.port) },
    ip: i.ctx.ip,
    ctx: i.ctx,
  });
  return { subscriptionId: r.subscriptionId, serverUuid: uuid, invoiceId: r.invoiceId };
}

// ---------- betalen ----------

/** Betaalpagina voor een open factuur; bewaart de payment-id bij de factuur. */
export async function startCheckout(invoiceId: number, cfg?: BillingConfig): Promise<string> {
  cfg ??= await getBillingConfig();
  const provider = billingActive(cfg) ? providerFor(cfg) : null;
  if (!provider) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "BILLING_DISABLED" });
  const [inv] = await getDb().select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "INVOICE_NOT_FOUND" });
  if (inv.status !== "open" && inv.status !== "overdue") throw new TRPCError({ code: "CONFLICT", message: "INVOICE_NOT_OPEN" });
  const base = getEnv().PANEL_URL;
  let r: { paymentId: string; url: string };
  try {
    r = await provider.createCheckout({
      invoiceId: inv.id,
      number: inv.number,
      description: inv.description,
      amountCents: inv.amountCents,
      currency: inv.currency,
      successUrl: `${base}/billing?paid=${inv.id}`,
      cancelUrl: `${base}/billing?canceled=${inv.id}`,
    });
  } catch (e) {
    console.error("[billing] checkout failed:", e);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "PAYMENT_PROVIDER_ERROR", cause: e instanceof ProviderError ? e : undefined });
  }
  await getDb().update(schema.invoices).set({ provider: provider.name, providerPaymentId: r.paymentId, checkoutUrl: r.url }).where(eq(schema.invoices.id, inv.id));
  return r.url;
}

const UNPAID = ["open", "overdue"] as const;

/**
 * Factuur betaald (webhook of admin). Idempotent: een tweede keer doet niets en geeft false.
 * Eerste betaling start de periode en de server; daarna heft betalen van alle achterstand de opschorting op.
 */
export async function markInvoicePaid(invoiceId: number, o: { provider: string | null; paymentId: string | null; byUserId?: number | null; ctx?: Ctx }): Promise<boolean> {
  const db = getDb();
  const now = billingNow();
  const res = await db.transaction(async (tx) => {
    const [inv] = await tx
      .update(schema.invoices)
      .set({ status: "paid", paidAt: now, ...(o.provider ? { provider: o.provider } : {}), ...(o.paymentId ? { providerPaymentId: o.paymentId } : {}) })
      .where(and(eq(schema.invoices.id, invoiceId), inArray(schema.invoices.status, [...UNPAID])))
      .returning();
    if (!inv) return null;
    if (!inv.subscriptionId) return { inv, start: false, serverId: null as number | null };
    const [sub] = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, inv.subscriptionId)).for("update");
    if (!sub || sub.status === "canceled") return { inv, start: false, serverId: null };
    if (sub.status === "pending") {
      const end = addMonths(now, 1);
      await tx.update(schema.subscriptions).set({ status: "active", anchorDay: now.getUTCDate(), currentPeriodStart: now, currentPeriodEnd: end, pastDueSince: null }).where(eq(schema.subscriptions.id, sub.id));
      await tx.update(schema.invoices).set({ periodStart: now, periodEnd: end }).where(eq(schema.invoices.id, inv.id));
      return { inv, start: true, serverId: sub.serverId };
    }
    const lifted = await recomputeSubscription(tx, sub);
    return { inv, start: false, serverId: lifted ? sub.serverId : null };
  });
  if (!res) return false;
  if (res.serverId) await liftBillingSuspension(res.serverId, { start: res.start });
  await logActivity({ action: "billing.invoice.paid", userId: o.byUserId ?? res.inv.userId, metadata: { invoiceId: res.inv.id, number: res.inv.number, provider: o.provider, paymentId: o.paymentId, byAdmin: !!o.byUserId }, ip: o.ctx?.ip ?? null, ctx: o.ctx });
  return true;
}

/**
 * Zet status/pastDueSince van een (niet-pending) abonnement opnieuw uit de openstaande facturen.
 * Geeft true als er geen achterstand meer is en de server weer mag (opschorting opheffen).
 */
export async function recomputeSubscription(tx: Tx, sub: SubRow): Promise<boolean> {
  if (sub.status === "pending" || sub.status === "canceled") return false;
  const overdue = await tx
    .select({ dueAt: schema.invoices.dueAt })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.subscriptionId, sub.id), eq(schema.invoices.status, "overdue")))
    .orderBy(asc(schema.invoices.dueAt));
  if (!overdue.length) {
    await tx.update(schema.subscriptions).set({ status: "active", pastDueSince: null, suspendedAt: null }).where(eq(schema.subscriptions.id, sub.id));
    return sub.status === "suspended" || sub.status === "past_due";
  }
  await tx.update(schema.subscriptions).set({ pastDueSince: overdue[0]!.dueAt }).where(eq(schema.subscriptions.id, sub.id));
  return false;
}

// ---------- opschorten en opheffen ----------

/** Stopt de server en schort hem op (een bestaande opschorting, bv. door een admin, blijft staan). */
export async function suspendForBilling(serverId: number, reason: (typeof BILLING_REASONS)[number]): Promise<void> {
  const db = getDb();
  const [srv] = await db.select({ uuid: schema.servers.uuid, suspendedAt: schema.servers.suspendedAt }).from(schema.servers).where(eq(schema.servers.id, serverId));
  if (!srv || srv.suspendedAt) return;
  const b = await fetchServerByUuid(srv.uuid);
  if (b) {
    try {
      await daemonFor(b.node).power(b.server.uuid, "stop");
    } catch (e) {
      // Draait niet (404/409) is prima; een onbereikbare node: toch opschorten, starten kan dan niet meer via het panel.
      if (!(e instanceof DaemonHttpError && (e.status === 404 || e.status === 409))) console.error(`[billing] stop ${srv.uuid} failed:`, (e as Error).message);
    }
  }
  const [done] = await db
    .update(schema.servers)
    .set({ suspendedAt: billingNow(), suspendedReason: reason })
    .where(and(eq(schema.servers.id, serverId), isNull(schema.servers.suspendedAt)))
    .returning({ id: schema.servers.id });
  if (done) await logActivity({ action: "billing.server.suspend", serverId, metadata: { serverUuid: srv.uuid, reason } });
}

/** Heft alleen een opschorting door de facturatie op; `start` start de server daarna (best effort). */
export async function liftBillingSuspension(serverId: number, o: { start?: boolean } = {}): Promise<void> {
  const db = getDb();
  const [srv] = await db
    .update(schema.servers)
    .set({ suspendedAt: null, suspendedReason: null })
    .where(and(eq(schema.servers.id, serverId), inArray(schema.servers.suspendedReason, [...BILLING_REASONS])))
    .returning({ uuid: schema.servers.uuid });
  if (!srv) return;
  await logActivity({ action: "billing.server.unsuspend", serverId, metadata: { serverUuid: srv.uuid } });
  if (!o.start) return;
  const b = await fetchServerByUuid(srv.uuid);
  if (!b || b.server.status === "installing") return; // installatie loopt nog: de gebruiker start zelf
  try {
    await daemonFor(b.node).power(b.server.uuid, "start");
  } catch (e) {
    console.error(`[billing] start ${srv.uuid} failed:`, (e as Error).message);
  }
}

/** Server helemaal verwijderen (daemon, routes, databases, rij). Gooit bij een onbereikbare node. */
export async function deletePlanServer(serverId: number, why: string): Promise<void> {
  const [srv] = await getDb().select({ uuid: schema.servers.uuid }).from(schema.servers).where(eq(schema.servers.id, serverId));
  if (!srv) return;
  const b = await fetchServerByUuid(srv.uuid);
  if (!b) return;
  await deleteServerFully(b, (dbFailed) =>
    logActivity({ action: "billing.server.delete", serverId, metadata: { serverUuid: b.server.uuid, serverName: b.server.name, reason: why, ...(dbFailed.length ? { databasesNotDropped: dbFailed } : {}) } }),
  );
}

/**
 * Abonnement meteen beëindigen. `deleteServer`: server weg, anders opgeschort (`SUBSCRIPTION_ENDED`).
 * Openstaande facturen van een nooit betaald abonnement vervallen.
 */
export async function endSubscription(subId: number, o: { deleteServer: boolean; reason: string }): Promise<void> {
  const db = getDb();
  const now = billingNow();
  const [sub] = await db
    .update(schema.subscriptions)
    .set({ status: "canceled", canceledAt: now, cancelAtPeriodEnd: false })
    .where(and(eq(schema.subscriptions.id, subId), ne(schema.subscriptions.status, "canceled")))
    .returning();
  if (!sub) return;
  // Status vóór de update is niet terug te lezen; nooit betaald = nog geen periode.
  if (!sub.free && !sub.currentPeriodEnd) {
    await db.update(schema.invoices).set({ status: "void" }).where(and(eq(schema.invoices.subscriptionId, sub.id), inArray(schema.invoices.status, [...UNPAID])));
  }
  await logActivity({ action: "billing.subscription.end", userId: sub.userId, serverId: sub.serverId, metadata: { subscriptionId: sub.id, reason: o.reason, deleteServer: o.deleteServer } });
  if (!sub.serverId) return;
  if (o.deleteServer) {
    try {
      await deletePlanServer(sub.serverId, o.reason);
    } catch (e) {
      // Node onbereikbaar: opschorten; de cyclus probeert het verwijderen later opnieuw (deleteAfterDays) of de admin doet het.
      console.error("[billing] delete failed:", (e as Error).message);
      await suspendForBilling(sub.serverId, "SUBSCRIPTION_ENDED");
    }
  } else await suspendForBilling(sub.serverId, "SUBSCRIPTION_ENDED");
}

// ---------- de cyclus ----------

export interface TickResult {
  invoiced: number;
  overdue: number;
  suspended: number;
  deleted: number;
  ended: number;
}

/** Maximaal zoveel achterstallige periodes per abonnement per tik inhalen (panel was lang uit). */
const MAX_CATCHUP = 12;

export async function billingTick(now: Date = billingNow()): Promise<TickResult> {
  const db = getDb();
  const cfg = await getBillingConfig();
  const out: TickResult = { invoiced: 0, overdue: 0, suspended: 0, deleted: 0, ended: 0 };
  const S = schema.subscriptions;

  // 1. Server verdwenen (eigenaar/admin verwijderde hem): abonnement beëindigd, geen nieuwe facturen.
  const gone = await db.select({ id: S.id }).from(S).where(and(isNull(S.serverId), ne(S.status, "canceled")));
  for (const s of gone) await endSubscription(s.id, { deleteServer: false, reason: "server_deleted" });
  out.ended += gone.length;

  // 2. Nooit betaald: eerste factuur verlopen → opruimen.
  const stale = await db
    .selectDistinct({ id: S.id })
    .from(S)
    .innerJoin(schema.invoices, eq(schema.invoices.subscriptionId, S.id))
    .where(and(eq(S.status, "pending"), inArray(schema.invoices.status, [...UNPAID]), lte(schema.invoices.dueAt, now)));
  for (const s of stale) {
    await endSubscription(s.id, { deleteServer: true, reason: "never_paid" });
    out.ended++;
  }

  // 3. Opgezegd en de periode is voorbij.
  const ending = await db.select().from(S).where(and(inArray(S.status, ["active", "past_due", "suspended"]), eq(S.cancelAtPeriodEnd, true), isNotNull(S.currentPeriodEnd), lte(S.currentPeriodEnd, now)));
  for (const s of ending) {
    await endSubscription(s.id, { deleteServer: false, reason: "canceled_by_user" });
    await db.update(S).set({ canceledAt: s.currentPeriodEnd }).where(eq(S.id, s.id));
    out.ended++;
  }

  if (billingActive(cfg)) {
    // 4. Verlengen: nieuwe factuur per verstreken periode. Claimen met de oude periode-einddatum (geen dubbele facturen).
    const due = await db.select().from(S).where(and(inArray(S.status, ["active", "past_due", "suspended"]), eq(S.free, false), eq(S.cancelAtPeriodEnd, false), isNotNull(S.currentPeriodEnd), lte(S.currentPeriodEnd, now))).limit(500);
    for (const s0 of due) {
      let s = s0;
      for (let n = 0; n < MAX_CATCHUP && s.currentPeriodEnd && s.currentPeriodEnd <= now; n++) {
        const start = s.currentPeriodEnd;
        const end = addMonths(start, 1, s.anchorDay ?? start.getUTCDate());
        const next = await db.transaction(async (tx) => {
          const [claimed] = await tx.update(S).set({ currentPeriodStart: start, currentPeriodEnd: end }).where(and(eq(S.id, s.id), eq(S.currentPeriodEnd, start))).returning();
          if (!claimed) return null;
          const [plan] = await tx.select({ name: schema.plans.name }).from(schema.plans).where(eq(schema.plans.id, s.planId));
          const [srv] = claimed.serverId ? await tx.select({ name: schema.servers.name }).from(schema.servers).where(eq(schema.servers.id, claimed.serverId)) : [];
          await issueInvoice(tx, cfg, { sub: claimed, description: `${plan?.name ?? "Plan"}${srv ? ` (${srv.name})` : ""}`, periodStart: start, periodEnd: end, dueAt: start, now });
          return claimed;
        });
        if (!next) break; // een ander proces was eerder
        out.invoiced++;
        s = next;
      }
    }

    // 5. Achterstallig.
    const late = await db
      .update(schema.invoices)
      .set({ status: "overdue" })
      .where(and(eq(schema.invoices.status, "open"), lte(schema.invoices.dueAt, now), isNotNull(schema.invoices.subscriptionId)))
      .returning({ subscriptionId: schema.invoices.subscriptionId });
    out.overdue += late.length;
    const lateSubs = await db
      .select({ id: S.id, since: sql<Date>`min(${schema.invoices.dueAt})`.mapWith(schema.invoices.dueAt) })
      .from(S)
      .innerJoin(schema.invoices, eq(schema.invoices.subscriptionId, S.id))
      .where(and(eq(S.status, "active"), eq(schema.invoices.status, "overdue")))
      .groupBy(S.id);
    for (const l of lateSubs) {
      await db.update(S).set({ status: "past_due", pastDueSince: l.since }).where(and(eq(S.id, l.id), eq(S.status, "active")));
      await logActivity({ action: "billing.subscription.past_due", metadata: { subscriptionId: l.id, since: l.since } });
    }

    // 6. Opschorten na X dagen.
    const cutoff = new Date(now.getTime() - cfg.suspendAfterDays * DAY_MS);
    const toSuspend = await db.select().from(S).where(and(eq(S.status, "past_due"), isNotNull(S.pastDueSince), lte(S.pastDueSince, cutoff)));
    for (const s of toSuspend) {
      const [claimed] = await db.update(S).set({ status: "suspended", suspendedAt: now }).where(and(eq(S.id, s.id), eq(S.status, "past_due"))).returning();
      if (!claimed) continue;
      if (claimed.serverId) await suspendForBilling(claimed.serverId, "BILLING_OVERDUE");
      out.suspended++;
    }
  }

  // 7. Verwijderen na Y dagen (optioneel).
  if (cfg.deleteAfterDays !== null) {
    const cutoff = new Date(now.getTime() - cfg.deleteAfterDays * DAY_MS);
    const victims = await db
      .select()
      .from(S)
      .where(and(isNotNull(S.serverId), or(and(eq(S.status, "suspended"), lte(S.pastDueSince, cutoff)), and(eq(S.status, "canceled"), lte(S.canceledAt, cutoff)))));
    for (const s of victims) {
      try {
        await deletePlanServer(s.serverId!, s.status === "suspended" ? "overdue" : "ended");
        if (s.status === "suspended") await db.update(S).set({ status: "canceled", canceledAt: now }).where(eq(S.id, s.id));
        out.deleted++;
      } catch (e) {
        console.error("[billing] delete failed:", (e as Error).message);
      }
    }
  }
  return out;
}
