/** Mock voor pakketten en facturatie (in-memory, alleen voor de UI). Standaard staan pakketten aan, facturatie ook (provider "stripe"). */
import { TRPCError } from "@trpc/server";
import type * as s from "../schemas";
import type { Implementation, SessionCtx } from "../trpc-builder";

type MockServer = { uuid: string; name: string; ownerId: number; type: "game" | "web"; suspended: s.ServerSummary["suspended"]; status: s.ServerStatus };

export interface BillingMockDeps {
  user: (id: number) => s.UserPublic;
  templates: () => Array<{ id: number; name: string; type: "game" | "web" }>;
  /** Maakt een server in de mock-state en geeft hem terug. */
  createServer: (o: { ownerId: number; name: string; templateId: number; limits: s.Limits }) => MockServer;
  servers: () => MockServer[];
  deleteServer: (uuid: string) => void;
  id: () => number;
}

const notFound = (m: string): never => {
  throw new TRPCError({ code: "NOT_FOUND", message: m });
};
const day = 86_400_000;
const d = (iso: string) => new Date(iso);

export function createBillingMock(deps: BillingMockDeps): { user: Implementation["billing"]; admin: Pick<Implementation["admin"], "plans" | "subscriptions" | "invoices" | "billing"> } {
  const settings: s.BillingSettings = {
    plansEnabled: true,
    freeSelfService: false,
    billingEnabled: true,
    provider: "stripe",
    suspendAfterDays: 7,
    deleteAfterDays: null,
    invoicePrefix: "INV-",
    issuer: { name: "Blokgenoten", address: "Voorbeeldstraat 1\n1234 AB Utrecht", email: "billing@panel.test", vatId: "", footer: "Bedankt!" },
    stripe: { secretKey: { set: true, hint: "…4242" }, webhookSecret: { set: true, hint: "…whsec" } },
    mollie: { apiKey: { set: false, hint: null } },
    webhookUrls: { stripe: "https://panel.test/api/billing/stripe", mollie: "https://panel.test/api/billing/mollie" },
  };
  const tplName = (id: number) => deps.templates().find((t) => t.id === id)?.name ?? `#${id}`;
  type PlanRow = Omit<s.Plan, "templates" | "activeSubscriptions">;
  const plans: PlanRow[] = [
    { id: 1, name: "Starter", description: "Kleine Minecraft-server voor een paar vrienden.", type: "game", templateIds: [1], nodeIds: null, ramMb: 2048, cpuPct: 100, diskMb: 10_000, maxDatabases: 1, maxBackups: 3, allocations: 1, priceCents: 500, currency: "EUR", visible: true, sortOrder: 0 },
    { id: 2, name: "Pro", description: "Meer geheugen, extra poort voor Bedrock.", type: "game", templateIds: [1], nodeIds: null, ramMb: 6144, cpuPct: 300, diskMb: 30_000, maxDatabases: 3, maxBackups: 10, allocations: 2, priceCents: 1500, currency: "EUR", visible: true, sortOrder: 1 },
    { id: 3, name: "Website", description: "Statische website met eigen domein.", type: "web", templateIds: [2], nodeIds: null, ramMb: 256, cpuPct: 50, diskMb: 2000, maxDatabases: 0, maxBackups: 2, allocations: 0, priceCents: 0, currency: "EUR", visible: true, sortOrder: 2 },
    { id: 4, name: "Intern", description: "Niet zichtbaar voor gebruikers.", type: "game", templateIds: [1], nodeIds: [1], ramMb: 8192, cpuPct: 400, diskMb: 50_000, maxDatabases: 5, maxBackups: 10, allocations: 3, priceCents: 0, currency: "EUR", visible: false, sortOrder: 9 },
  ];
  type SubRow = Omit<s.Subscription, "user" | "plan" | "server"> & { userId: number; planId: number; serverUuid: string | null };
  const subs: SubRow[] = [
    { id: 1, userId: 2, planId: 1, serverUuid: "3a1d9b7c-5e6f-4a8b-9c0d-112233445566", status: "active", free: false, priceCents: 500, currency: "EUR", cancelAtPeriodEnd: false, currentPeriodStart: d("2026-11-10T10:00:00Z"), currentPeriodEnd: d("2026-12-10T10:00:00Z"), pastDueSince: null, canceledAt: null, createdAt: d("2026-10-10T10:00:00Z") },
  ];
  type InvRow = Omit<s.Invoice, "user"> & { userId: number };
  const invoices: InvRow[] = [
    { id: 1, number: "INV-2026-0001", userId: 2, subscriptionId: 1, description: "Starter (Creative)", amountCents: 500, currency: "EUR", status: "paid", periodStart: d("2026-10-10T10:00:00Z"), periodEnd: d("2026-11-10T10:00:00Z"), issuedAt: d("2026-10-10T10:00:00Z"), dueAt: d("2026-10-10T10:00:00Z"), paidAt: d("2026-10-10T10:05:00Z"), provider: "stripe" },
    { id: 2, number: "INV-2026-0002", userId: 2, subscriptionId: 1, description: "Starter (Creative)", amountCents: 500, currency: "EUR", status: "open", periodStart: d("2026-11-10T10:00:00Z"), periodEnd: d("2026-12-10T10:00:00Z"), issuedAt: d("2026-11-10T10:00:00Z"), dueAt: d("2026-11-30T10:00:00Z"), paidAt: null, provider: null },
  ];

  const plan = (p: PlanRow): s.Plan => ({
    ...p,
    templates: p.templateIds.map((id) => ({ id, name: tplName(id) })),
    activeSubscriptions: subs.filter((x) => x.planId === p.id && x.status !== "canceled").length,
  });
  const sub = (x: SubRow): s.Subscription => {
    const { userId, planId, serverUuid, ...rest } = x;
    const p = plans.find((y) => y.id === planId)!;
    const srv = serverUuid ? deps.servers().find((y) => y.uuid === serverUuid) : undefined;
    return { ...rest, user: deps.user(userId), plan: { id: p.id, name: p.name, type: p.type }, server: srv ? { uuid: srv.uuid, name: srv.name } : null };
  };
  const inv = (x: InvRow): s.Invoice => {
    const { userId, ...rest } = x;
    return { ...rest, user: deps.user(userId) };
  };
  const pageOf = <T extends { id: number }>(items: T[], input: { cursor?: string | null; limit: number }) => {
    const start = input.cursor ? items.findIndex((x) => String(x.id) === input.cursor) + 1 : 0;
    const slice = items.slice(start, start + input.limit);
    return { items: slice, nextCursor: start + input.limit < items.length ? String(slice[slice.length - 1]!.id) : null };
  };
  const uid = (ctx: { session: SessionCtx | null }) => ctx.session!.userId;
  const isAdmin = (ctx: { session: SessionCtx | null }) => !!ctx.session?.isAdmin && !!ctx.session.totpVerified;
  const canSubscribe = () => settings.plansEnabled && (settings.billingEnabled || settings.freeSelfService);

  const provision = (userId: number, input: { planId: number; name: string; templateId: number }, free: boolean): s.SubscribeResult => {
    const p = plans.find((x) => x.id === input.planId) ?? notFound("PLAN_NOT_FOUND");
    if (!p.templateIds.includes(input.templateId)) throw new TRPCError({ code: "FORBIDDEN", message: "TEMPLATE_NOT_ALLOWED" });
    const paid = !free && settings.billingEnabled && p.priceCents > 0;
    const srv = deps.createServer({ ownerId: userId, name: input.name, templateId: input.templateId, limits: { cpuPct: p.cpuPct, ramMb: p.ramMb, swapMb: 0, diskMb: p.diskMb } });
    if (paid) srv.suspended = { reason: "BILLING_UNPAID", at: new Date() };
    const now = new Date();
    const row: SubRow = {
      id: deps.id(), userId, planId: p.id, serverUuid: srv.uuid, status: paid ? "pending" : "active", free: !paid, priceCents: paid ? p.priceCents : 0, currency: p.currency,
      cancelAtPeriodEnd: false, currentPeriodStart: paid ? null : now, currentPeriodEnd: null, pastDueSince: null, canceledAt: null, createdAt: now,
    };
    subs.push(row);
    let checkoutUrl: string | null = null;
    if (paid) {
      const i: InvRow = { id: deps.id(), number: `INV-2026-${String(invoices.length + 1).padStart(4, "0")}`, userId, subscriptionId: row.id, description: `${p.name} (${input.name})`, amountCents: p.priceCents, currency: p.currency, status: "open", periodStart: null, periodEnd: null, issuedAt: now, dueAt: new Date(now.getTime() + 2 * day), paidAt: null, provider: settings.provider };
      invoices.push(i);
      checkoutUrl = `/billing?mockCheckout=${i.id}`;
    }
    return { subscription: sub(row), serverUuid: srv.uuid, checkoutUrl };
  };

  const user: Implementation["billing"] = {
    status: ({ ctx }) => ({
      plansEnabled: settings.plansEnabled,
      canSubscribe: canSubscribe(),
      billingEnabled: settings.billingEnabled,
      hasSubscriptions: subs.some((x) => x.userId === uid(ctx)) || invoices.some((x) => x.userId === uid(ctx)),
    }),
    plans: () => (settings.plansEnabled ? plans.filter((p) => p.visible).sort((a, b) => a.sortOrder - b.sortOrder).map(plan) : []),
    subscriptions: ({ ctx }) => subs.filter((x) => x.userId === uid(ctx)).map(sub),
    invoices: ({ input, ctx }) => pageOf(invoices.filter((x) => x.userId === uid(ctx)).reverse().map(inv), input),
    invoice: ({ input, ctx }) => {
      const x = invoices.find((i) => i.id === input.id && (i.userId === uid(ctx) || isAdmin(ctx))) ?? notFound("INVOICE_NOT_FOUND");
      const u = deps.user(x.userId);
      return {
        ...inv(x),
        issuer: settings.issuer,
        customer: { name: u.name, discordId: u.discordId },
        lines: [{ description: x.description, quantity: 1, unitCents: x.amountCents, totalCents: x.amountCents }],
        canPay: x.userId === uid(ctx) && settings.billingEnabled && (x.status === "open" || x.status === "overdue"),
      };
    },
    subscribe: ({ input, ctx }) => {
      if (!settings.plansEnabled) throw new TRPCError({ code: "FORBIDDEN", message: "PLANS_DISABLED" });
      if (!canSubscribe()) throw new TRPCError({ code: "FORBIDDEN", message: "SELF_SERVICE_DISABLED" });
      const p = plans.find((x) => x.id === input.planId && x.visible) ?? notFound("PLAN_NOT_FOUND");
      return provision(uid(ctx), input, !settings.billingEnabled || p.priceCents === 0);
    },
    pay: ({ input, ctx }) => {
      const x = invoices.find((i) => i.id === input.invoiceId && i.userId === uid(ctx)) ?? notFound("INVOICE_NOT_FOUND");
      if (x.status !== "open" && x.status !== "overdue") throw new TRPCError({ code: "CONFLICT", message: "INVOICE_NOT_OPEN" });
      return { url: `/billing?mockCheckout=${x.id}` };
    },
    cancel: ({ input, ctx }) => {
      const x = subs.find((y) => y.id === input.id && y.userId === uid(ctx)) ?? notFound("SUBSCRIPTION_NOT_FOUND");
      if (x.free) {
        x.status = "canceled";
        x.canceledAt = new Date();
        if (input.deleteServer && x.serverUuid) {
          deps.deleteServer(x.serverUuid);
          x.serverUuid = null;
        }
      } else x.cancelAtPeriodEnd = true;
      return sub(x);
    },
    resume: ({ input, ctx }) => {
      const x = subs.find((y) => y.id === input.id && y.userId === uid(ctx)) ?? notFound("SUBSCRIPTION_NOT_FOUND");
      if (x.status === "canceled") throw new TRPCError({ code: "CONFLICT", message: "SUBSCRIPTION_ENDED" });
      x.cancelAtPeriodEnd = false;
      return sub(x);
    },
  };

  const admin: Pick<Implementation["admin"], "plans" | "subscriptions" | "invoices" | "billing"> = {
    plans: {
      list: () => [...plans].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id).map(plan),
      create: ({ input }) => {
        const p: PlanRow = { ...input, id: deps.id() };
        plans.push(p);
        return plan(p);
      },
      update: ({ input }) => {
        const p = plans.find((x) => x.id === input.id) ?? notFound("PLAN_NOT_FOUND");
        Object.assign(p, input);
        return plan(p);
      },
      delete: ({ input }) => {
        if (subs.some((x) => x.planId === input.id && x.status !== "canceled")) throw new TRPCError({ code: "CONFLICT", message: "PLAN_IN_USE" });
        const i = plans.findIndex((x) => x.id === input.id);
        if (i >= 0) plans.splice(i, 1);
        return { ok: true as const };
      },
    },
    subscriptions: {
      list: ({ input }) => pageOf(subs.filter((x) => (!input.userId || x.userId === input.userId) && (!input.status || x.status === input.status)).map(sub), input),
      grant: ({ input }) => provision(input.userId, input, true),
      cancel: ({ input }) => {
        const x = subs.find((y) => y.id === input.id) ?? notFound("SUBSCRIPTION_NOT_FOUND");
        x.status = "canceled";
        x.canceledAt = new Date();
        if (input.deleteServer && x.serverUuid) {
          deps.deleteServer(x.serverUuid);
          x.serverUuid = null;
        }
        return { ok: true as const };
      },
    },
    invoices: {
      list: ({ input }) => pageOf(invoices.filter((x) => (!input.userId || x.userId === input.userId) && (!input.status || x.status === input.status)).reverse().map(inv), input),
      markPaid: ({ input }) => {
        const x = invoices.find((i) => i.id === input.id) ?? notFound("INVOICE_NOT_FOUND");
        x.status = "paid";
        x.paidAt = new Date();
        return inv(x);
      },
      void: ({ input }) => {
        const x = invoices.find((i) => i.id === input.id) ?? notFound("INVOICE_NOT_FOUND");
        if (x.status === "paid") throw new TRPCError({ code: "CONFLICT", message: "INVOICE_PAID" });
        x.status = "void";
        return inv(x);
      },
    },
    billing: {
      get: () => structuredClone(settings),
      update: ({ input }) => {
        const { stripeSecretKey, stripeWebhookSecret, mollieApiKey, ...rest } = input;
        const hint = (v: string | null) => (v ? { set: true, hint: `…${v.slice(-4)}` } : { set: false, hint: null });
        if (stripeSecretKey !== undefined) settings.stripe.secretKey = hint(stripeSecretKey);
        if (stripeWebhookSecret !== undefined) settings.stripe.webhookSecret = hint(stripeWebhookSecret);
        if (mollieApiKey !== undefined) settings.mollie.apiKey = hint(mollieApiKey);
        const next = { ...settings, ...rest };
        if (next.billingEnabled && (!next.provider || (next.provider === "stripe" ? !next.stripe.secretKey.set || !next.stripe.webhookSecret.set : !next.mollie.apiKey.set))) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "BILLING_PROVIDER_NOT_CONFIGURED" });
        }
        Object.assign(settings, rest);
        return structuredClone(settings);
      },
    },
  };
  return { user, admin };
}
