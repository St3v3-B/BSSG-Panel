// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { TRPCError } from "@trpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Implementation } from "@panel/api";
import { BillingAdmin } from "@/app/_components/admin/billing-admin";
import { parsePrice, PlansAdmin } from "@/app/_components/admin/billing-plans";
import { BillingSettingsAdmin } from "@/app/_components/admin/billing-settings";
import { BillingOverview } from "@/app/_components/billing/billing-overview";
import { BillingSuspendedNotice, InvoiceView } from "@/app/_components/billing/invoice-view";
import { PlanPicker } from "@/app/_components/billing/plan-picker";
import { renderWithTrpc, sessionFor } from "./utils";

const push = vi.fn();
let search = new URLSearchParams();
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => search,
  usePathname: () => "/billing",
}));

afterEach(() => {
  cleanup();
  push.mockClear();
  search = new URLSearchParams();
});

const user = { session: sessionFor("user"), locale: "en" as const };
const admin = { session: sessionFor("admin"), locale: "en" as const };
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

describe("pakketten (gebruiker)", () => {
  it("toont zichtbare pakketten met prijs en limieten; betaald pakket gaat naar de betaalpagina", async () => {
    const { bodies } = renderWithTrpc(<PlanPicker />, user);
    const cards = await screen.findAllByTestId("plan-card");
    expect(cards.map((c) => within(c).getByRole("heading").textContent)).toEqual(["Starter", "Pro", "Website"]);
    expect(within(cards[0]!).getByTestId("plan-price").textContent).toMatch(/5[.,]00.*month/);
    expect(within(cards[2]!).getByTestId("plan-price").textContent).toBe("Free");
    expect(cards[0]!.textContent).toContain("1 port");
    fireEvent.click(within(cards[0]!).getByRole("button", { name: "Choose" }));
    const submit = await screen.findByRole("button", { name: "Continue to payment" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mijn SMP" } });
    fireEvent.click(submit);
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/billing\?mockCheckout=\d+$/)));
    expect(inputs(bodies, "billing.subscribe")[0]).toMatchObject({ planId: 1, name: "Mijn SMP", templateId: 1 });
  });

  it("gratis pakket: naar de nieuwe server", async () => {
    renderWithTrpc(<PlanPicker />, user);
    const cards = await screen.findAllByTestId("plan-card");
    fireEvent.click(within(cards[2]!).getByRole("button", { name: "Choose" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Site" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/servers\/[0-9a-f-]{36}$/)));
  });

  it("pakketten uit of zelf kiezen uit: duidelijke melding, knoppen uit", async () => {
    renderWithTrpc(<PlanPicker />, { ...user, patch: (m) => void (m.billing.status = () => ({ plansEnabled: false, canSubscribe: false, billingEnabled: false, hasSubscriptions: false })) });
    expect(await screen.findByText("Plans aren't available on this panel.")).toBeTruthy();
    cleanup();
    renderWithTrpc(<PlanPicker />, { ...user, patch: (m) => void (m.billing.status = () => ({ plansEnabled: true, canSubscribe: false, billingEnabled: false, hasSubscriptions: false })) });
    expect(await screen.findByText(/can't pick a plan yourself/)).toBeTruthy();
    for (const b of screen.getAllByRole("button", { name: "Choose" })) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it("toont de foutmelding van de server (NO_CAPACITY) vertaald", async () => {
    renderWithTrpc(<PlanPicker />, {
      ...user,
      patch: (m) =>
        void (m.billing.subscribe = () => {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_CAPACITY" });
        }),
    });
    fireEvent.click((await screen.findAllByRole("button", { name: "Choose" }))[0]!);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no node with enough room/);
  });
});

describe("facturatie (gebruiker)", () => {
  it("abonnementen en facturen; betalen; opzeggen en verlengen", async () => {
    search = new URLSearchParams("paid=2");
    const { bodies } = renderWithTrpc(<BillingOverview />, user);
    expect(await screen.findByText(/Thanks! Your payment/)).toBeTruthy();
    const sub = await screen.findByTestId("subscription");
    expect(sub.textContent).toContain("Starter");
    expect(within(sub).getByTestId("subscription-status").textContent).toBe("Active");
    const rows = await screen.findAllByTestId("invoice-row");
    expect(rows.map((r) => r.querySelector("td")!.textContent)).toEqual(["INV-2026-0002", "INV-2026-0001"]);
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Pay" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/billing?mockCheckout=2"));
    expect(within(rows[1]!).queryByRole("button", { name: "Pay" })).toBeNull();
    fireEvent.click(within(sub).getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("cancel-confirm").textContent).toContain("until the end of the period");
    fireEvent.click(within(screen.getByTestId("cancel-confirm")).getByRole("button", { name: "Yes, cancel" }));
    expect(await within(sub).findByRole("button", { name: "Keep subscription" })).toBeTruthy();
    expect(sub.textContent).toMatch(/Ends on/);
    fireEvent.click(within(sub).getByRole("button", { name: "Keep subscription" }));
    await within(sub).findByRole("button", { name: "Cancel" });
    expect(inputs(bodies, "billing.cancel")[0]).toMatchObject({ id: 1, deleteServer: false });
    expect(inputs(bodies, "billing.resume")[0]).toEqual({ id: 1 });
  });

  it("printbare factuur met afzender, regels en totaal", async () => {
    renderWithTrpc(<InvoiceView id={2} />, user);
    const inv = await screen.findByTestId("invoice");
    expect(within(inv).getByRole("heading", { name: "Invoice INV-2026-0002" })).toBeTruthy();
    expect(inv.textContent).toContain("Blokgenoten");
    expect(inv.textContent).toContain("Voorbeeldstraat 1");
    expect(within(inv).getByTestId("invoice-total").textContent).toMatch(/5[.,]00/);
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: /Print/ }));
    expect(print).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pay" })).toBeTruthy();
  });

  it("factuur van een ander: niet gevonden", async () => {
    renderWithTrpc(<InvoiceView id={2} />, { session: sessionFor("user", { userId: 3 }), locale: "en" });
    await waitFor(() => expect(screen.queryByTestId("invoice")).toBeNull());
    expect(await screen.findByText(/INVOICE_NOT_FOUND|not found/i)).toBeTruthy();
  });

  it("melding bij opschorting door de facturatie, niet bij een admin-opschorting", () => {
    renderWithTrpc(<BillingSuspendedNotice suspended={{ reason: "BILLING_OVERDUE", at: new Date() }} />, user);
    expect(screen.getByTestId("billing-suspended").textContent).toContain("invoice is overdue");
    expect(screen.getByRole("link", { name: "Go to billing" }).getAttribute("href")).toBe("/billing");
    cleanup();
    renderWithTrpc(<BillingSuspendedNotice suspended={{ reason: "misbruik", at: new Date() }} />, user);
    expect(screen.queryByTestId("billing-suspended")).toBeNull();
  });
});

describe("admin", () => {
  it("parsePrice", () => {
    expect(parsePrice("12,5")).toBe(1250);
    expect(parsePrice("0.99")).toBe(99);
    expect(parsePrice("7")).toBe(700);
    expect(parsePrice("1.234")).toBeNull();
    expect(parsePrice("abc")).toBeNull();
  });

  it("pakket maken met prijs in euro's en templates van het juiste type", async () => {
    const { bodies } = renderWithTrpc(<PlansAdmin />, admin);
    expect((await screen.findAllByTestId("admin-plan")).length).toBe(4);
    fireEvent.click(screen.getByRole("button", { name: "New plan" }));
    const form = await screen.findByTestId("plan-form");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Mega" } });
    fireEvent.change(within(form).getByLabelText("Price per month"), { target: { value: "12,50" } });
    fireEvent.click(await within(form).findByLabelText("Paper"));
    expect(within(form).queryByLabelText("Static site")).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getAllByTestId("admin-plan").length).toBe(5));
    expect(inputs(bodies, "admin.plans.create")[0]).toMatchObject({ name: "Mega", priceCents: 1250, templateIds: [1], type: "game", allocations: 1, nodeIds: null });
  });

  it("pakket met abonnementen verwijderen → PLAN_IN_USE", async () => {
    renderWithTrpc(<PlansAdmin />, admin);
    const plan = (await screen.findAllByTestId("admin-plan"))[0]!;
    fireEvent.click(within(plan).getByRole("button", { name: "Delete Starter" }));
    fireEvent.click(within(plan).getByRole("button", { name: "Delete this plan?" }));
    expect((await screen.findByTestId("admin-error")).textContent).toMatch(/still has subscriptions/);
  });

  it("abonnementen en facturen; handmatig betaald markeren", async () => {
    const { bodies } = renderWithTrpc(<BillingAdmin />, admin);
    const subs = await screen.findByTestId("admin-subscriptions");
    expect(subs.textContent).toContain("blokgenoot");
    fireEvent.click(screen.getByRole("tab", { name: "Invoices" }));
    const rows = await screen.findAllByTestId("admin-invoice-row");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Mark paid" }));
    await waitFor(() => expect(inputs(bodies, "admin.invoices.markPaid")).toEqual([{ id: 2 }]));
    await waitFor(() => expect(within(screen.getAllByTestId("admin-invoice-row")[0]!).getByTestId("invoice-status").textContent).toBe("Paid"));
  });

  it("instellingen: sleutels alleen als hint; facturatie aan zonder provider geeft een melding", async () => {
    const patch = (m: Implementation) => {
      const orig = m.admin.billing.get;
      m.admin.billing.get = (o) => ({ ...(orig(o) as Awaited<ReturnType<typeof orig>>), billingEnabled: false, provider: null });
    };
    const { bodies } = renderWithTrpc(<BillingSettingsAdmin />, { ...admin, patch });
    const form = await screen.findByTestId("billing-settings");
    expect((within(form).getByLabelText("Plans enabled") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(form).getByLabelText("Billing enabled"));
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect((await screen.findByTestId("admin-error")).textContent).toMatch(/payment provider/);
    fireEvent.change(within(form).getByLabelText("Payment provider"), { target: { value: "mollie" } });
    expect(within(form).getByText("Not set.")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Mollie API key"), { target: { value: "test_abcdefghijklmnop" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(inputs(bodies, "admin.billing.update")[1]).toMatchObject({ billingEnabled: true, provider: "mollie", mollieApiKey: "test_abcdefghijklmnop" });
    expect(await within(form).findByText(/Set \(…mnop\)/)).toBeTruthy();
    expect((within(form).getByLabelText("Mollie API key") as HTMLInputElement).value).toBe("");
  });
});
