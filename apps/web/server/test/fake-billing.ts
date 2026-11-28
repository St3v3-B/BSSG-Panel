/**
 * Nep-Stripe en nep-Mollie voor tests: vervangt fetch van de billing-providers (geen netwerk).
 * Houdt aangemaakte checkout-sessies en payments bij; `molliePaid(id)` zet een payment op betaald.
 */
import { MOLLIE_API, STRIPE_API } from "../billing/providers";

export interface FakeCheckout {
  provider: "stripe" | "mollie";
  id: string;
  invoiceId: number;
  amount: string;
  currency: string;
  status: string;
  webhookUrl: string | null;
  auth: string | null;
}

export class FakeBilling {
  readonly checkouts: FakeCheckout[] = [];
  /** Volgende create geeft deze HTTP-status (eenmalig). */
  failNext: number | null = null;
  private n = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = new Headers(init?.headers).get("authorization");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (this.failNext && method === "POST") {
      const s = this.failNext;
      this.failNext = null;
      return json(s, { error: { message: "fake failure" }, detail: "fake failure" });
    }
    if (url === `${STRIPE_API}/checkout/sessions` && method === "POST") {
      const p = new URLSearchParams(String(init?.body));
      const id = `cs_test_${++this.n}`;
      this.checkouts.push({ provider: "stripe", id, invoiceId: Number(p.get("metadata[invoice_id]")), amount: p.get("line_items[0][price_data][unit_amount]")!, currency: p.get("line_items[0][price_data][currency]")!, status: "open", webhookUrl: null, auth });
      return json(200, { id, url: `https://checkout.stripe.test/c/${id}` });
    }
    if (url === `${MOLLIE_API}/payments` && method === "POST") {
      const b = JSON.parse(String(init?.body)) as { amount: { currency: string; value: string }; webhookUrl: string; metadata: { invoiceId: number } };
      const id = `tr_fake${++this.n}`;
      this.checkouts.push({ provider: "mollie", id, invoiceId: b.metadata.invoiceId, amount: b.amount.value, currency: b.amount.currency, status: "open", webhookUrl: b.webhookUrl, auth });
      return json(201, { id, _links: { checkout: { href: `https://mollie.test/checkout/${id}` } } });
    }
    const m = new RegExp(`^${MOLLIE_API.replace(/\./g, "\\.")}/payments/(tr_[A-Za-z0-9]+)$`).exec(url);
    if (m && method === "GET") {
      const c = this.checkouts.find((x) => x.provider === "mollie" && x.id === m[1]);
      if (!c) return json(404, { detail: "not found" });
      return json(200, { id: c.id, status: c.status, metadata: { invoiceId: c.invoiceId } });
    }
    return json(404, { error: { message: `unexpected ${method} ${url}` } });
  };

  molliePaid(id: string): void {
    this.checkouts.find((c) => c.id === id)!.status = "paid";
  }

  last(): FakeCheckout {
    return this.checkouts[this.checkouts.length - 1]!;
  }
}
