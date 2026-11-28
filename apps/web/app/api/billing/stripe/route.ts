import { handleWebhook } from "@/server/billing/webhooks";

export const dynamic = "force-dynamic";
/** Stripe-webhook (publiek; signature-check in handleWebhook). */
export const POST = (req: Request) => handleWebhook("stripe", req);
