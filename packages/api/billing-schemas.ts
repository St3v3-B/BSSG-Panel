/**
 * Schema's voor pakketten (plans), abonnementen, facturen en facturatie-instellingen.
 * Eigenaar: orchestrator (gemaakt door agent billing). Wordt via ./schemas.ts geëxporteerd.
 */
import { z } from "zod";

const Id = z.number().int().positive();
const ServerType = z.enum(["game", "web"]);
const UserRef = z.object({ id: Id, discordId: z.string(), name: z.string().nullable(), avatarUrl: z.string().nullable() });

/** ISO 4217, hoofdletters (EUR, USD, ...). */
export const Currency = z.string().regex(/^[A-Z]{3}$/, "INVALID_CURRENCY");

/**
 * Pakket zoals de admin het invoert. Regels die zod niet uitdrukt (templates van het juiste type,
 * game ≥ 1 poort, web 0 poorten, nodes bestaan) controleert de server: BAD_REQUEST `PLAN_INVALID: <veld>`.
 */
export const PlanInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  type: ServerType,
  templateIds: z.array(Id).min(1).max(100),
  /** null = node automatisch kiezen uit alle nodes met voldoende capaciteit. */
  nodeIds: z.array(Id).min(1).max(100).nullable().default(null),
  ramMb: z.number().int().min(64).max(1_048_576),
  /** 100 = één core. */
  cpuPct: z.number().int().min(1).max(6400),
  diskMb: z.number().int().min(64).max(10_485_760),
  maxDatabases: z.number().int().min(0).max(100),
  maxBackups: z.number().int().min(0).max(1000),
  /** Poorten van een game-server (≥ 1); 0 voor websites. */
  allocations: z.number().int().min(0).max(100),
  /** Prijs per maand in centen; 0 = gratis. */
  priceCents: z.number().int().min(0).max(100_000_000),
  currency: Currency.default("EUR"),
  visible: z.boolean().default(true),
  sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
});
export type PlanInput = z.infer<typeof PlanInput>;

export const Plan = PlanInput.extend({
  id: Id,
  templates: z.array(z.object({ id: Id, name: z.string() })),
  /** Abonnementen die niet opgezegd/beëindigd zijn. */
  activeSubscriptions: z.number().int(),
});
export type Plan = z.infer<typeof Plan>;

/**
 * - pending: wacht op de eerste betaling (server bestaat, opgeschort met `BILLING_UNPAID`)
 * - active: betaald of gratis
 * - past_due: factuur achterstallig, server draait nog
 * - suspended: te lang achterstallig, server opgeschort (`BILLING_OVERDUE`)
 * - canceled: beëindigd (opgezegd na afloop periode, nooit betaald, of server weg)
 */
export const SubscriptionStatus = z.enum(["pending", "active", "past_due", "suspended", "canceled"]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

export const Subscription = z.object({
  id: Id,
  user: UserRef,
  plan: z.object({ id: Id, name: z.string(), type: ServerType }),
  server: z.object({ uuid: z.string().uuid(), name: z.string() }).nullable(),
  status: SubscriptionStatus,
  /** Geen facturen (door een admin toegekend of gratis pakket). */
  free: z.boolean(),
  priceCents: z.number().int(),
  currency: z.string(),
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodStart: z.date().nullable(),
  currentPeriodEnd: z.date().nullable(),
  pastDueSince: z.date().nullable(),
  canceledAt: z.date().nullable(),
  createdAt: z.date(),
});
export type Subscription = z.infer<typeof Subscription>;

/** `overdue` = open en de vervaldatum is voorbij. */
export const InvoiceStatus = z.enum(["open", "paid", "overdue", "void"]);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

export const Invoice = z.object({
  id: Id,
  number: z.string(),
  user: UserRef,
  subscriptionId: Id.nullable(),
  description: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  status: InvoiceStatus,
  periodStart: z.date().nullable(),
  periodEnd: z.date().nullable(),
  issuedAt: z.date(),
  dueAt: z.date(),
  paidAt: z.date().nullable(),
  provider: z.string().nullable(),
});
export type Invoice = z.infer<typeof Invoice>;

/** Afzender op de factuur (Admin → Instellingen → Facturatie). */
export const BillingIssuer = z.object({
  name: z.string().max(200),
  /** Meerdere regels toegestaan. */
  address: z.string().max(1000),
  email: z.string().max(200),
  vatId: z.string().max(50),
  footer: z.string().max(1000),
});
export type BillingIssuer = z.infer<typeof BillingIssuer>;

/** Printbare factuur. */
export const InvoiceDetail = Invoice.extend({
  issuer: BillingIssuer,
  customer: z.object({ name: z.string().nullable(), discordId: z.string().nullable() }),
  lines: z.array(z.object({ description: z.string(), quantity: z.number().int(), unitCents: z.number().int(), totalCents: z.number().int() })),
  /** Mag de kijker nu betalen (eigen open/achterstallige factuur en facturatie aan). */
  canPay: z.boolean(),
});
export type InvoiceDetail = z.infer<typeof InvoiceDetail>;

export const BillingProviderName = z.enum(["stripe", "mollie"]);
export type BillingProviderName = z.infer<typeof BillingProviderName>;

/** Wat de gebruiker te zien krijgt (menu-items, knoppen). */
export const BillingStatus = z.object({
  /** Pakketten staan aan (Admin → Instellingen → Facturatie). */
  plansEnabled: z.boolean(),
  /** De gebruiker kan nu zelf een pakket kiezen (facturatie aan, of gratis zelf kiezen aan). */
  canSubscribe: z.boolean(),
  billingEnabled: z.boolean(),
  /** Heeft (of had) abonnementen of facturen: dan is de pagina Facturatie zichtbaar. */
  hasSubscriptions: z.boolean(),
});
export type BillingStatus = z.infer<typeof BillingStatus>;

export const SubscribeResult = z.object({
  subscription: Subscription,
  serverUuid: z.string().uuid(),
  /** URL van de betaalpagina; null bij gratis (of als de provider even niet bereikbaar was: betaal dan via Facturatie). */
  checkoutUrl: z.string().nullable(),
});
export type SubscribeResult = z.infer<typeof SubscribeResult>;

const SecretStatus = z.object({ set: z.boolean(), hint: z.string().nullable() });

export const BillingSettings = z.object({
  plansEnabled: z.boolean(),
  /** Zonder facturatie: gebruikers mogen zelf (gratis) een pakket kiezen. */
  freeSelfService: z.boolean(),
  billingEnabled: z.boolean(),
  provider: BillingProviderName.nullable(),
  /** Na zoveel dagen achterstand wordt de server opgeschort (0 = meteen). */
  suspendAfterDays: z.number().int().min(0).max(365),
  /** Na zoveel dagen achterstand (of na het einde van een opgezegd abonnement) de server verwijderen; null = nooit. */
  deleteAfterDays: z.number().int().min(1).max(3650).nullable(),
  /** Voorvoegsel van factuurnummers, bv. "INV-" → INV-2026-0001. */
  invoicePrefix: z.string().regex(/^[A-Za-z0-9-]{0,12}$/),
  issuer: BillingIssuer,
  stripe: z.object({ secretKey: SecretStatus, webhookSecret: SecretStatus }),
  mollie: z.object({ apiKey: SecretStatus }),
  /** In te stellen bij de provider. */
  webhookUrls: z.object({ stripe: z.string(), mollie: z.string() }),
});
export type BillingSettings = z.infer<typeof BillingSettings>;

/** Geheimen: weggelaten = ongewijzigd, null = wissen. Facturatie aanzetten zonder ingestelde provider → PRECONDITION_FAILED `BILLING_PROVIDER_NOT_CONFIGURED`. */
export const BillingSettingsInput = BillingSettings.pick({
  plansEnabled: true,
  freeSelfService: true,
  billingEnabled: true,
  provider: true,
  suspendAfterDays: true,
  deleteAfterDays: true,
  invoicePrefix: true,
  issuer: true,
})
  .partial()
  .extend({
    stripeSecretKey: z.string().trim().min(10).max(300).nullable().optional(),
    stripeWebhookSecret: z.string().trim().min(10).max(300).nullable().optional(),
    mollieApiKey: z.string().trim().min(10).max(300).nullable().optional(),
  });
export type BillingSettingsInput = z.infer<typeof BillingSettingsInput>;
