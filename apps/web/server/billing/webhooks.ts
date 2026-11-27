/**
 * Webhook-ingangen voor de betaalproviders (`/api/billing/stripe`, `/api/billing/mollie`). Publiek, dus:
 * eerst de signature (Stripe) of het URL-token + terugvragen bij de provider (Mollie), dan pas iets doen.
 * Idempotent via `billing_events`. Antwoorden: 200 verwerkt/genegeerd, 400 ongeldig, 404 provider niet ingesteld,
 * 500 tijdelijke fout (de provider probeert het dan opnieuw).
 */
import type { BillingProviderName } from "@panel/api";
import { and, eq } from "drizzle-orm";
import { ensureBooted } from "../boot";
import { getDb, schema } from "../db";
import { markInvoicePaid } from "./core";
import { ProviderError, providerFor, SignatureError } from "./providers";
import { getBillingConfig } from "./settings";

/** Grootste webhook-body die we lezen (Stripe-events zijn een paar kB). */
const MAX_BODY = 256 * 1024;

const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function handleWebhook(name: BillingProviderName, req: Request): Promise<Response> {
  await ensureBooted();
  const cfg = await getBillingConfig();
  // Ook bij uitgezette facturatie verwerken we nog betalingen van al geopende betaalpagina's, mits de sleutels er zijn.
  const provider = providerFor(cfg, name);
  if (!provider) return text(404, "not configured");
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return text(413, "too large");
  const body = await req.text();
  if (body.length > MAX_BODY) return text(413, "too large");
  let ev;
  try {
    ev = await provider.verifyWebhook({ headers: req.headers, body, url: new URL(req.url) });
  } catch (e) {
    if (e instanceof SignatureError) return text(400, "invalid signature");
    console.error(`[billing] ${name} webhook:`, (e as Error).message);
    return text(e instanceof ProviderError ? 502 : 500, "error");
  }
  const db = getDb();
  const [seen] = await db.select().from(schema.billingEvents).where(and(eq(schema.billingEvents.provider, name), eq(schema.billingEvents.eventId, ev.eventId)));
  if (seen) return text(200, "duplicate");
  if (ev.invoiceId && ev.paid) {
    const [inv] = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.id, ev.invoiceId));
    if (!inv) return text(200, "unknown invoice");
    try {
      await markInvoicePaid(inv.id, { provider: name, paymentId: ev.paymentId });
    } catch (e) {
      console.error(`[billing] ${name} webhook: marking invoice ${inv.id} paid failed:`, e);
      return text(500, "error");
    }
  }
  await db.insert(schema.billingEvents).values({ provider: name, eventId: ev.eventId, invoiceId: ev.invoiceId && ev.paid ? ev.invoiceId : null }).onConflictDoNothing();
  return text(200, "ok");
}
