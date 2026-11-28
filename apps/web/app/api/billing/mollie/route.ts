import { handleWebhook } from "@/server/billing/webhooks";

export const dynamic = "force-dynamic";
/** Mollie-webhook (publiek; URL-token + payment terugvragen bij Mollie in handleWebhook). */
export const POST = (req: Request) => handleWebhook("mollie", req);
