/**
 * Instellingen voor pakketten en facturatie, in de tabel `settings` (sleutels `billing_*`).
 * API-sleutels staan versleuteld onder sleutels die op `_enc` eindigen en gaan nooit terug naar de browser.
 */
import type { BillingIssuer, BillingProviderName, BillingSettings, BillingSettingsInput } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { inArray, like } from "drizzle-orm";
import { getDb, schema } from "../db";
import { getEnv } from "../env";
import { decrypt, encrypt } from "../lib/crypto";

export interface BillingConfig {
  plansEnabled: boolean;
  freeSelfService: boolean;
  billingEnabled: boolean;
  provider: BillingProviderName | null;
  suspendAfterDays: number;
  deleteAfterDays: number | null;
  invoicePrefix: string;
  issuer: BillingIssuer;
  secrets: { stripeSecretKey: string | null; stripeWebhookSecret: string | null; mollieApiKey: string | null };
}

export const BILLING_DEFAULTS = {
  plansEnabled: false,
  freeSelfService: false,
  billingEnabled: false,
  provider: null,
  suspendAfterDays: 7,
  deleteAfterDays: null,
  invoicePrefix: "INV-",
  issuer: { name: "", address: "", email: "", vatId: "", footer: "" },
} satisfies Omit<BillingConfig, "secrets">;

const KEY = {
  plansEnabled: "billing_plans_enabled",
  freeSelfService: "billing_free_self_service",
  billingEnabled: "billing_enabled",
  provider: "billing_provider",
  suspendAfterDays: "billing_suspend_after_days",
  deleteAfterDays: "billing_delete_after_days",
  invoicePrefix: "billing_invoice_prefix",
  issuer: "billing_issuer",
  stripeSecretKey: "billing_stripe_secret_key_enc",
  stripeWebhookSecret: "billing_stripe_webhook_secret_enc",
  mollieApiKey: "billing_mollie_api_key_enc",
} as const;

const SECRET_KEYS = ["stripeSecretKey", "stripeWebhookSecret", "mollieApiKey"] as const;

function dec(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  try {
    return decrypt(v);
  } catch {
    return null; // andere PANEL_ENCRYPTION_KEY: behandelen als niet ingesteld
  }
}

export async function getBillingConfig(): Promise<BillingConfig> {
  const rows = await getDb().select().from(schema.settings).where(like(schema.settings.key, "billing_%"));
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const bool = (k: string, d: boolean) => (typeof m.get(k) === "boolean" ? (m.get(k) as boolean) : d);
  const int = (k: string, d: number | null) => {
    const v = m.get(k);
    return typeof v === "number" && Number.isInteger(v) ? v : d;
  };
  const provider = m.get(KEY.provider);
  const prefix = m.get(KEY.invoicePrefix);
  const issuer = (m.get(KEY.issuer) ?? {}) as Partial<BillingIssuer>;
  return {
    plansEnabled: bool(KEY.plansEnabled, BILLING_DEFAULTS.plansEnabled),
    freeSelfService: bool(KEY.freeSelfService, BILLING_DEFAULTS.freeSelfService),
    billingEnabled: bool(KEY.billingEnabled, BILLING_DEFAULTS.billingEnabled),
    provider: provider === "stripe" || provider === "mollie" ? provider : null,
    suspendAfterDays: int(KEY.suspendAfterDays, BILLING_DEFAULTS.suspendAfterDays)!,
    deleteAfterDays: int(KEY.deleteAfterDays, BILLING_DEFAULTS.deleteAfterDays),
    invoicePrefix: typeof prefix === "string" ? prefix : BILLING_DEFAULTS.invoicePrefix,
    issuer: { ...BILLING_DEFAULTS.issuer, ...Object.fromEntries(Object.entries(issuer).filter(([, v]) => typeof v === "string")) },
    secrets: {
      stripeSecretKey: dec(m.get(KEY.stripeSecretKey)),
      stripeWebhookSecret: dec(m.get(KEY.stripeWebhookSecret)),
      mollieApiKey: dec(m.get(KEY.mollieApiKey)),
    },
  };
}

/** De gekozen provider heeft wat hij nodig heeft. */
export function providerConfigured(c: Pick<BillingConfig, "provider" | "secrets">): boolean {
  if (c.provider === "stripe") return !!c.secrets.stripeSecretKey && !!c.secrets.stripeWebhookSecret;
  if (c.provider === "mollie") return !!c.secrets.mollieApiKey;
  return false;
}

/** Facturatie staat aan én de provider is ingesteld. */
export const billingActive = (c: BillingConfig) => c.billingEnabled && providerConfigured(c);

const hint = (v: string | null) => (v ? { set: true, hint: `…${v.slice(-4)}` } : { set: false, hint: null });

export function webhookUrls() {
  const base = getEnv().PANEL_URL;
  return { stripe: `${base}/api/billing/stripe`, mollie: `${base}/api/billing/mollie` };
}

export function toBillingSettings(c: BillingConfig): BillingSettings {
  return {
    plansEnabled: c.plansEnabled,
    freeSelfService: c.freeSelfService,
    billingEnabled: c.billingEnabled,
    provider: c.provider,
    suspendAfterDays: c.suspendAfterDays,
    deleteAfterDays: c.deleteAfterDays,
    invoicePrefix: c.invoicePrefix,
    issuer: c.issuer,
    stripe: { secretKey: hint(c.secrets.stripeSecretKey), webhookSecret: hint(c.secrets.stripeWebhookSecret) },
    mollie: { apiKey: hint(c.secrets.mollieApiKey) },
    webhookUrls: webhookUrls(),
  };
}

/** Schrijft de gewijzigde velden; weigert facturatie aan zonder werkende provider. Geeft de nieuwe config terug. */
export async function updateBillingConfig(input: BillingSettingsInput): Promise<BillingConfig> {
  const cur = await getBillingConfig();
  const secrets = { ...cur.secrets };
  for (const k of SECRET_KEYS) if (input[k] !== undefined) secrets[k] = input[k] ?? null;
  const next: BillingConfig = {
    plansEnabled: input.plansEnabled ?? cur.plansEnabled,
    freeSelfService: input.freeSelfService ?? cur.freeSelfService,
    billingEnabled: input.billingEnabled ?? cur.billingEnabled,
    provider: input.provider !== undefined ? input.provider : cur.provider,
    suspendAfterDays: input.suspendAfterDays ?? cur.suspendAfterDays,
    deleteAfterDays: input.deleteAfterDays !== undefined ? input.deleteAfterDays : cur.deleteAfterDays,
    invoicePrefix: input.invoicePrefix ?? cur.invoicePrefix,
    issuer: input.issuer ?? cur.issuer,
    secrets,
  };
  if (next.billingEnabled && !providerConfigured(next)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "BILLING_PROVIDER_NOT_CONFIGURED" });
  if (next.deleteAfterDays !== null && next.deleteAfterDays < next.suspendAfterDays) throw new TRPCError({ code: "BAD_REQUEST", message: "DELETE_BEFORE_SUSPEND" });

  const values: Array<{ key: string; value: unknown }> = [
    { key: KEY.plansEnabled, value: next.plansEnabled },
    { key: KEY.freeSelfService, value: next.freeSelfService },
    { key: KEY.billingEnabled, value: next.billingEnabled },
    { key: KEY.provider, value: next.provider ?? "" },
    { key: KEY.suspendAfterDays, value: next.suspendAfterDays },
    { key: KEY.deleteAfterDays, value: next.deleteAfterDays ?? "" },
    { key: KEY.invoicePrefix, value: next.invoicePrefix },
    { key: KEY.issuer, value: next.issuer },
  ];
  const clear: string[] = [];
  for (const k of SECRET_KEYS) {
    if (input[k] === undefined) continue;
    if (input[k]) values.push({ key: KEY[k], value: encrypt(input[k]!) });
    else clear.push(KEY[k]);
  }
  const db = getDb();
  await db.transaction(async (tx) => {
    for (const v of values) {
      await tx
        .insert(schema.settings)
        .values({ key: v.key, value: v.value })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value: v.value, updatedAt: new Date() } });
    }
    if (clear.length) await tx.delete(schema.settings).where(inArray(schema.settings.key, clear));
  });
  return next;
}
