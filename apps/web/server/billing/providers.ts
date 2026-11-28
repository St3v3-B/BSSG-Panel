/**
 * Betaalproviders achter één interface. Geen SDK's: Stripe en Mollie via hun REST-API met fetch.
 * - Stripe: Checkout Session (mode=payment) per factuur; webhook `checkout.session.completed`
 *   (en `checkout.session.async_payment_succeeded`) met HMAC-SHA256-signature (`Stripe-Signature`).
 * - Mollie: payment per factuur; de webhook bevat alleen `id=tr_…`. Mollie ondertekent die niet, dus
 *   (1) de webhook-URL draagt een HMAC-token per factuur en (2) we halen de payment altijd zelf op
 *   bij Mollie en vertrouwen alleen dat antwoord.
 * `setBillingFetch` vervangt fetch in tests (nooit echte netwerkcalls).
 */
import { createHmac } from "node:crypto";
import type { BillingProviderName } from "@panel/api";
import { getEnv } from "../env";
import { safeEqual } from "../lib/crypto";
import type { BillingConfig } from "./settings";

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** Alleen voor tests. */
export function setBillingFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

export class ProviderError extends Error {}
export class SignatureError extends Error {}

export interface CheckoutInput {
  invoiceId: number;
  number: string;
  description: string;
  amountCents: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

/** Resultaat van een geverifieerde webhook. `invoiceId` null = event dat ons niet aangaat. */
export interface WebhookEvent {
  eventId: string;
  invoiceId: number | null;
  paymentId: string | null;
  paid: boolean;
}

export interface BillingProvider {
  name: BillingProviderName;
  createCheckout(i: CheckoutInput): Promise<{ paymentId: string; url: string }>;
  /** Gooit SignatureError als het verzoek niet echt van de provider komt. */
  verifyWebhook(req: { headers: Headers; body: string; url: URL }): Promise<WebhookEvent>;
}

export const STRIPE_API = "https://api.stripe.com/v1";
export const MOLLIE_API = "https://api.mollie.com/v2";
/** Maximale leeftijd van een Stripe-signature (zoals de officiële SDK). */
export const STRIPE_TOLERANCE_S = 300;

// ---------- Stripe ----------

export function stripeSignature(secret: string, payload: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
}

/** Header zoals Stripe hem stuurt (voor tests en de fake). */
export function stripeSignatureHeader(secret: string, payload: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${stripeSignature(secret, payload, timestamp)}`;
}

export function verifyStripeSignature(header: string | null, payload: string, secret: string, nowS = Math.floor(Date.now() / 1000)): void {
  if (!header) throw new SignatureError("missing Stripe-Signature");
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t" && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v) v1.push(v);
  }
  if (t === null || !v1.length) throw new SignatureError("malformed Stripe-Signature");
  if (Math.abs(nowS - t) > STRIPE_TOLERANCE_S) throw new SignatureError("timestamp outside tolerance");
  const expected = stripeSignature(secret, payload, t);
  if (!v1.some((s) => safeEqual(s, expected))) throw new SignatureError("signature mismatch");
}

function form(obj: Record<string, string | number>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export function stripeProvider(secretKey: string, webhookSecret: string): BillingProvider {
  return {
    name: "stripe",
    async createCheckout(i) {
      const body = form({
        mode: "payment",
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
        client_reference_id: String(i.invoiceId),
        "metadata[invoice_id]": i.invoiceId,
        "payment_intent_data[metadata][invoice_id]": i.invoiceId,
        "line_items[0][quantity]": 1,
        "line_items[0][price_data][currency]": i.currency.toLowerCase(),
        "line_items[0][price_data][unit_amount]": i.amountCents,
        "line_items[0][price_data][product_data][name]": `${i.number} · ${i.description}`.slice(0, 250),
      });
      const r = await fetchImpl(`${STRIPE_API}/checkout/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await r.json().catch(() => null)) as { id?: string; url?: string; error?: { message?: string } } | null;
      if (!r.ok || !j?.id || !j.url) throw new ProviderError(`stripe: ${j?.error?.message ?? `HTTP ${r.status}`}`);
      return { paymentId: j.id, url: j.url };
    },
    async verifyWebhook({ headers, body }) {
      verifyStripeSignature(headers.get("stripe-signature"), body, webhookSecret);
      let ev: { id?: string; type?: string; data?: { object?: { id?: string; payment_status?: string; client_reference_id?: string | null; metadata?: Record<string, string> } } };
      try {
        ev = JSON.parse(body);
      } catch {
        throw new SignatureError("invalid JSON");
      }
      if (!ev.id) throw new SignatureError("event without id");
      const o = ev.data?.object;
      const relevant = ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded";
      const raw = o?.metadata?.invoice_id ?? o?.client_reference_id ?? null;
      const invoiceId = relevant && raw && /^\d+$/.test(raw) ? Number(raw) : null;
      return { eventId: ev.id, invoiceId, paymentId: o?.id ?? null, paid: relevant && o?.payment_status === "paid" };
    },
  };
}

// ---------- Mollie ----------

/** Token in de webhook-URL, gebonden aan de factuur (sleutel afgeleid van PANEL_ENCRYPTION_KEY). */
export function mollieWebhookToken(invoiceId: number): string {
  return createHmac("sha256", getEnv().encryptionKey).update(`mollie-webhook:${invoiceId}`).digest("base64url").slice(0, 32);
}

const mollieAmount = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

export function mollieProvider(apiKey: string, webhookBase: string): BillingProvider {
  const auth = { authorization: `Bearer ${apiKey}` };
  return {
    name: "mollie",
    async createCheckout(i) {
      const webhookUrl = `${webhookBase}?invoice=${i.invoiceId}&token=${mollieWebhookToken(i.invoiceId)}`;
      const r = await fetchImpl(`${MOLLIE_API}/payments`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          amount: { currency: i.currency, value: mollieAmount(i.amountCents) },
          description: `${i.number} ${i.description}`.slice(0, 255),
          redirectUrl: i.successUrl,
          cancelUrl: i.cancelUrl,
          webhookUrl,
          metadata: { invoiceId: i.invoiceId },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await r.json().catch(() => null)) as { id?: string; _links?: { checkout?: { href?: string } }; detail?: string } | null;
      const url = j?._links?.checkout?.href;
      if (!r.ok || !j?.id || !url) throw new ProviderError(`mollie: ${j?.detail ?? `HTTP ${r.status}`}`);
      return { paymentId: j.id, url };
    },
    async verifyWebhook({ body, url }) {
      const invoice = url.searchParams.get("invoice");
      const token = url.searchParams.get("token") ?? "";
      if (!invoice || !/^\d+$/.test(invoice) || !safeEqual(token, mollieWebhookToken(Number(invoice)))) throw new SignatureError("invalid webhook token");
      const id = new URLSearchParams(body).get("id");
      if (!id || !/^tr_[A-Za-z0-9]+$/.test(id)) throw new SignatureError("invalid payment id");
      // Alleen het antwoord van Mollie zelf telt.
      const r = await fetchImpl(`${MOLLIE_API}/payments/${id}`, { headers: auth, signal: AbortSignal.timeout(15_000) });
      if (r.status === 404) throw new SignatureError("unknown payment");
      const j = (await r.json().catch(() => null)) as { id?: string; status?: string; metadata?: { invoiceId?: number | string } | null } | null;
      if (!r.ok || !j?.id) throw new ProviderError(`mollie: HTTP ${r.status}`);
      const meta = j.metadata?.invoiceId;
      if (meta === undefined || String(meta) !== invoice) throw new SignatureError("payment does not belong to this invoice");
      return { eventId: `${j.id}:${j.status}`, invoiceId: Number(invoice), paymentId: j.id, paid: j.status === "paid" };
    },
  };
}

/** Provider uit de config, of null als die niet (volledig) is ingesteld. */
export function providerFor(c: BillingConfig, name: BillingProviderName | null = c.provider): BillingProvider | null {
  if (name === "stripe" && c.secrets.stripeSecretKey && c.secrets.stripeWebhookSecret) return stripeProvider(c.secrets.stripeSecretKey, c.secrets.stripeWebhookSecret);
  if (name === "mollie" && c.secrets.mollieApiKey) return mollieProvider(c.secrets.mollieApiKey, `${getEnv().PANEL_URL}/api/billing/mollie`);
  return null;
}
