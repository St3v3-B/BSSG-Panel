/** tRPC-implementatie van `billing.*` en `admin.{plans,subscriptions,invoices,billing}`. */
import type { Ctx, Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, count, eq, lt, or, type SQL } from "drizzle-orm";
import { logActivity } from "../activity";
import { forbidApiKey } from "../apikey";
import { getDb, schema } from "../db";
import { isFullAdmin } from "../servers-data";
import {
  deletePlanServer,
  endSubscription,
  fetchInvoices,
  fetchSubscriptions,
  invoiceDetail,
  liftBillingSuspension,
  markInvoicePaid,
  provisionPlanServer,
  recomputeSubscription,
  startCheckout,
  subscriptionById,
  type ProvisionResult,
} from "./core";
import { toPlans, validatePlan } from "./plans";
import { billingActive, getBillingConfig, toBillingSettings, updateBillingConfig } from "./settings";

const ok = { ok: true as const };
const uid = (ctx: Ctx) => ctx.session!.userId;
const cursorOf = (c: string | null | undefined) => (c && /^\d+$/.test(c) ? Number(c) : null);

function paged<T extends { id: number }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? String(items[items.length - 1]!.id) : null };
}

async function planRow(id: number) {
  const [p] = await getDb().select().from(schema.plans).where(eq(schema.plans.id, id));
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "PLAN_NOT_FOUND" });
  return p;
}

async function subscribeResult(r: ProvisionResult, checkoutUrl: string | null) {
  return { subscription: await subscriptionById(r.subscriptionId), serverUuid: r.serverUuid, checkoutUrl };
}

async function ownSubscription(ctx: Ctx, id: number) {
  const [s] = await getDb().select().from(schema.subscriptions).where(and(eq(schema.subscriptions.id, id), eq(schema.subscriptions.userId, uid(ctx))));
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "SUBSCRIPTION_NOT_FOUND" });
  return s;
}

export const billing: Implementation["billing"] = {
  status: async ({ ctx }) => {
    const cfg = await getBillingConfig();
    const db = getDb();
    const [[subs], [invs]] = await Promise.all([
      db.select({ n: count() }).from(schema.subscriptions).where(eq(schema.subscriptions.userId, uid(ctx))),
      db.select({ n: count() }).from(schema.invoices).where(eq(schema.invoices.userId, uid(ctx))),
    ]);
    return {
      plansEnabled: cfg.plansEnabled,
      canSubscribe: cfg.plansEnabled && (billingActive(cfg) || cfg.freeSelfService),
      billingEnabled: billingActive(cfg),
      hasSubscriptions: (subs?.n ?? 0) + (invs?.n ?? 0) > 0,
    };
  },

  plans: async () => {
    const cfg = await getBillingConfig();
    if (!cfg.plansEnabled) return [];
    const rows = await getDb().select().from(schema.plans).where(eq(schema.plans.visible, true)).orderBy(asc(schema.plans.sortOrder), asc(schema.plans.id));
    return toPlans(rows);
  },

  subscriptions: ({ ctx }) => fetchSubscriptions(eq(schema.subscriptions.userId, uid(ctx))),

  invoices: async ({ input, ctx }) => {
    const c = cursorOf(input.cursor);
    return paged(await fetchInvoices(and(eq(schema.invoices.userId, uid(ctx)), c ? lt(schema.invoices.id, c) : undefined), input.limit + 1), input.limit);
  },

  invoice: ({ input, ctx }) => invoiceDetail(input.id, { userId: uid(ctx), fullAdmin: isFullAdmin(ctx) }),

  subscribe: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const cfg = await getBillingConfig();
    if (!cfg.plansEnabled) throw new TRPCError({ code: "FORBIDDEN", message: "PLANS_DISABLED" });
    const active = billingActive(cfg);
    if (!active && !cfg.freeSelfService) throw new TRPCError({ code: "FORBIDDEN", message: "SELF_SERVICE_DISABLED" });
    const plan = await planRow(input.planId);
    if (!plan.visible) throw new TRPCError({ code: "NOT_FOUND", message: "PLAN_NOT_FOUND" });
    const paid = active && plan.priceCents > 0;
    const r = await provisionPlanServer({ userId: uid(ctx), plan, templateId: input.templateId, name: input.name, variables: input.variables, paid, grantedBy: null, ctx });
    let url: string | null = null;
    if (r.invoiceId) {
      try {
        url = await startCheckout(r.invoiceId, cfg);
      } catch {
        url = null; // de gebruiker betaalt later via Facturatie
      }
    }
    return subscribeResult(r, url);
  },

  pay: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const [inv] = await getDb().select().from(schema.invoices).where(and(eq(schema.invoices.id, input.invoiceId), eq(schema.invoices.userId, uid(ctx))));
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "INVOICE_NOT_FOUND" });
    return { url: await startCheckout(inv.id) };
  },

  cancel: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const s = await ownSubscription(ctx, input.id);
    if (s.status === "canceled") throw new TRPCError({ code: "CONFLICT", message: "SUBSCRIPTION_ENDED" });
    // Gratis of nooit betaald: meteen beëindigen. Betaald: aan het einde van de periode.
    if (s.free || s.status === "pending") {
      let del = s.status === "pending";
      if (input.deleteServer && s.serverId) {
        const [srv] = await getDb().select({ name: schema.servers.name }).from(schema.servers).where(eq(schema.servers.id, s.serverId));
        if (srv && input.confirmName !== srv.name) throw new TRPCError({ code: "BAD_REQUEST", message: "NAME_MISMATCH" });
        del = true;
      }
      await endSubscription(s.id, { deleteServer: del, reason: "canceled_by_user" });
    } else {
      await getDb().update(schema.subscriptions).set({ cancelAtPeriodEnd: true }).where(eq(schema.subscriptions.id, s.id));
      await logActivity({ action: "billing.subscription.cancel", userId: uid(ctx), serverId: s.serverId, metadata: { subscriptionId: s.id, at: s.currentPeriodEnd }, ip: ctx.ip, ctx });
    }
    return subscriptionById(s.id);
  },

  resume: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const s = await ownSubscription(ctx, input.id);
    if (s.status === "canceled") throw new TRPCError({ code: "CONFLICT", message: "SUBSCRIPTION_ENDED" });
    if (s.cancelAtPeriodEnd) {
      await getDb().update(schema.subscriptions).set({ cancelAtPeriodEnd: false }).where(eq(schema.subscriptions.id, s.id));
      await logActivity({ action: "billing.subscription.resume", userId: uid(ctx), serverId: s.serverId, metadata: { subscriptionId: s.id }, ip: ctx.ip, ctx });
    }
    return subscriptionById(s.id);
  },
};

export const billingAdmin: Pick<Implementation["admin"], "plans" | "subscriptions" | "invoices" | "billing"> = {
  plans: {
    list: async () => toPlans(await getDb().select().from(schema.plans).orderBy(asc(schema.plans.sortOrder), asc(schema.plans.id))),
    create: async ({ input, ctx }) => {
      await validatePlan(input);
      const [p] = await getDb().insert(schema.plans).values(input).returning();
      await logActivity({ action: "admin.plan.create", userId: uid(ctx), metadata: { id: p!.id, name: p!.name }, ip: ctx.ip, ctx });
      return (await toPlans([p!]))[0]!;
    },
    update: async ({ input, ctx }) => {
      const { id, ...rest } = input;
      await planRow(id);
      await validatePlan(rest);
      // Bestaande servers houden hun limieten; wijzigingen gelden voor nieuwe abonnementen.
      const [p] = await getDb().update(schema.plans).set({ ...rest, updatedAt: new Date() }).where(eq(schema.plans.id, id)).returning();
      await logActivity({ action: "admin.plan.update", userId: uid(ctx), metadata: { id, name: p!.name }, ip: ctx.ip, ctx });
      return (await toPlans([p!]))[0]!;
    },
    delete: async ({ input, ctx }) => {
      const p = await planRow(input.id);
      const [c] = await getDb().select({ n: count() }).from(schema.subscriptions).where(eq(schema.subscriptions.planId, p.id));
      if ((c?.n ?? 0) > 0) throw new TRPCError({ code: "CONFLICT", message: "PLAN_IN_USE" });
      await getDb().delete(schema.plans).where(eq(schema.plans.id, p.id));
      await logActivity({ action: "admin.plan.delete", userId: uid(ctx), metadata: { id: p.id, name: p.name }, ip: ctx.ip, ctx });
      return ok;
    },
  },

  subscriptions: {
    list: async ({ input }) => {
      const c = cursorOf(input.cursor);
      const conds: SQL[] = [];
      if (c) conds.push(lt(schema.subscriptions.id, c));
      if (input.userId) conds.push(eq(schema.subscriptions.userId, input.userId));
      if (input.status) conds.push(eq(schema.subscriptions.status, input.status));
      return paged(await fetchSubscriptions(conds.length ? and(...conds) : undefined, { limit: input.limit + 1 }), input.limit);
    },
    grant: async ({ input, ctx }) => {
      const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, input.userId));
      if (!u || u.isEmergency) throw new TRPCError({ code: "NOT_FOUND", message: "USER_NOT_FOUND" });
      const plan = await planRow(input.planId);
      const r = await provisionPlanServer({ userId: u.id, plan, templateId: input.templateId, name: input.name, variables: input.variables, paid: false, grantedBy: uid(ctx), ctx });
      return subscribeResult(r, null);
    },
    cancel: async ({ input, ctx }) => {
      const [s] = await getDb().select().from(schema.subscriptions).where(eq(schema.subscriptions.id, input.id));
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "SUBSCRIPTION_NOT_FOUND" });
      if (s.status === "canceled" && !(input.deleteServer && s.serverId)) throw new TRPCError({ code: "CONFLICT", message: "SUBSCRIPTION_ENDED" });
      if (s.status === "canceled") {
        // Al beëindigd maar de server staat er nog (opgeschort): alsnog verwijderen.
        await deletePlanServer(s.serverId!, "admin");
      } else await endSubscription(s.id, { deleteServer: input.deleteServer, reason: "admin" });
      await logActivity({ action: "admin.subscription.cancel", userId: uid(ctx), serverId: s.serverId, metadata: { subscriptionId: s.id, deleteServer: input.deleteServer }, ip: ctx.ip, ctx });
      return ok;
    },
  },

  invoices: {
    list: async ({ input }) => {
      const c = cursorOf(input.cursor);
      const conds: SQL[] = [];
      if (c) conds.push(lt(schema.invoices.id, c));
      if (input.userId) conds.push(eq(schema.invoices.userId, input.userId));
      if (input.status) conds.push(eq(schema.invoices.status, input.status));
      return paged(await fetchInvoices(conds.length ? and(...conds) : undefined, input.limit + 1), input.limit);
    },
    markPaid: async ({ input, ctx }) => {
      const [inv] = await getDb().select().from(schema.invoices).where(eq(schema.invoices.id, input.id));
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "INVOICE_NOT_FOUND" });
      if (inv.status !== "open" && inv.status !== "overdue") throw new TRPCError({ code: "CONFLICT", message: "INVOICE_NOT_OPEN" });
      await markInvoicePaid(inv.id, { provider: "manual", paymentId: null, byUserId: uid(ctx), ctx });
      const [r] = await fetchInvoices(eq(schema.invoices.id, inv.id));
      return r!;
    },
    void: async ({ input, ctx }) => {
      const db = getDb();
      const lifted = await db.transaction(async (tx) => {
        const [inv] = await tx
          .update(schema.invoices)
          .set({ status: "void" })
          .where(and(eq(schema.invoices.id, input.id), or(eq(schema.invoices.status, "open"), eq(schema.invoices.status, "overdue"))))
          .returning();
        if (!inv) {
          const [x] = await tx.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.id, input.id));
          throw new TRPCError(x ? { code: "CONFLICT", message: "INVOICE_NOT_OPEN" } : { code: "NOT_FOUND", message: "INVOICE_NOT_FOUND" });
        }
        if (!inv.subscriptionId) return null;
        const [sub] = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, inv.subscriptionId)).for("update");
        return sub && (await recomputeSubscription(tx, sub)) ? sub.serverId : null;
      });
      if (lifted) await liftBillingSuspension(lifted);
      await logActivity({ action: "admin.invoice.void", userId: uid(ctx), metadata: { invoiceId: input.id }, ip: ctx.ip, ctx });
      const [r] = await fetchInvoices(eq(schema.invoices.id, input.id));
      return r!;
    },
  },

  billing: {
    get: async () => toBillingSettings(await getBillingConfig()),
    update: async ({ input, ctx }) => {
      const next = await updateBillingConfig(input);
      const changed = Object.keys(input).map((k) => (/Key|Secret/.test(k) ? `${k}(secret)` : k));
      await logActivity({ action: "admin.billing.settings", userId: uid(ctx), metadata: { changed, billingEnabled: next.billingEnabled, plansEnabled: next.plansEnabled, provider: next.provider }, ip: ctx.ip, ctx });
      return toBillingSettings(next);
    },
  },
};
