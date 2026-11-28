// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Implementation } from "@panel/api";
import { MailOverview } from "@/app/_components/mail/overview";
import { DomainWizard, MailDomainList } from "@/app/_components/mail/domains";
import { MailDomainDetailView } from "@/app/_components/mail/domain-detail";
import { DnsRecords } from "@/app/_components/mail/dns-records";
import { MailQueue } from "@/app/_components/mail/queue";
import { generatePassword, passwordScore, relativeTime } from "@/app/_components/mail/primitives";
import { renderWithTrpc, sessionFor } from "./utils";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/admin/mail", useParams: () => ({}) }));

const writeText = vi.fn(async () => {});
beforeAll(() => {
  process.env.NEXT_PUBLIC_PANEL_MOCK = "1";
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
beforeEach(() => {
  writeText.mockClear();
  push.mockClear();
  window.history.replaceState(null, "", "/");
});
afterEach(cleanup);

const nl = { session: sessionFor("admin"), locale: "nl" as const };
const en = { session: sessionFor("admin"), locale: "en" as const };
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

describe("Mail-overzicht", () => {
  it("toont stackstatus, containers, wachtrij en de systeemcheck met samenvatting", async () => {
    renderWithTrpc(<MailOverview />, nl);
    expect((await screen.findByTestId("mail-stack-state")).textContent).toBe("Mail staat aan");
    expect(screen.getAllByTestId("mail-container")).toHaveLength(6);
    expect(screen.getAllByTestId("mail-container").find((c) => c.textContent?.includes("clamav"))?.dataset.health).toBe("starting");
    expect(screen.getByTestId("mail-queue-deferred").textContent).toBe("3");
    expect(await screen.findByTestId("mail-check-summary")).toBeTruthy();
    expect(screen.getByTestId("mail-check-summary").textContent).toBe("6 van 10 in orde");
    expect(screen.getByText("3 verplichte checks vragen aandacht")).toBeTruthy();
    expect(screen.getByTestId("mail-check-time").textContent).toMatch(/25 minuten geleden/);
    // rode checks staan bovenaan; de eerste is uitgeklapt met kopieerbare waarden
    const ptr = screen.getByTestId("mail-check-ptr");
    expect(ptr.dataset.tone).toBe("fail");
    expect(within(ptr).getByText("Reverse DNS (PTR)")).toBeTruthy();
    expect(within(ptr).getByText("203.0.113.10")).toBeTruthy();
    fireEvent.click(within(ptr).getByRole("button", { name: /Te gebruiken waarden: IP-adres/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("203.0.113.10"));
    expect(await within(ptr).findByText("Gekopieerd!")).toBeTruthy();
    // tweede rode check is ingeklapt en klapt open met de knop
    const fcrdns = screen.getByTestId("mail-check-fcrdns");
    const toggle = within(fcrdns).getByRole("button", { name: /Wat moet ik doen/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(fcrdns).getByText("mail.panel.test. IN A 203.0.113.10")).toBeTruthy();
    // waarschuwing (niet verplicht) en groene check
    expect(screen.getByTestId("mail-check-disk").dataset.tone).toBe("warn");
    expect(screen.getByTestId("mail-check-clock").dataset.tone).toBe("ok");
  });

  it("opnieuw controleren toont per check een laadtoestand en roept checks.run aan", async () => {
    const { calls } = renderWithTrpc(<MailOverview />, nl);
    const btn = await screen.findByTestId("mail-check-run");
    await screen.findByTestId("mail-check-list");
    fireEvent.click(btn);
    await waitFor(() => expect(btn.textContent).toMatch(/Bezig met controleren/));
    expect(screen.getByTestId("mail-check-ptr").dataset.tone).toBe("running");
    await waitFor(() => expect(calls.some((c) => c.includes("mail.checks.run"))).toBe(true));
    await waitFor(() => expect(btn.textContent).toMatch(/Opnieuw controleren/), { timeout: 4000 });
    expect(screen.getByTestId("mail-check-time").textContent).toMatch(/nu|seconden/);
  });

  it("uitzetten vraagt bevestiging; daarna is aanzetten geblokkeerd zolang verplichte checks rood zijn", async () => {
    const { bodies } = renderWithTrpc(<MailOverview />, nl);
    const sw = await screen.findByTestId("mail-toggle");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    expect(await screen.findByText("Mail uitzetten?")).toBeTruthy();
    expect(inputs(bodies, "mail.disable")).toEqual([]);
    fireEvent.click(screen.getByTestId("mail-toggle-confirm"));
    await waitFor(() => expect(inputs(bodies, "mail.disable")).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("mail-stack-state").textContent).toBe("Mail staat uit"));
    expect(screen.getByTestId("mail-blocked").textContent).toMatch(/3 verplichte checks zijn rood/);
    expect((screen.getByTestId("mail-toggle") as HTMLButtonElement).disabled).toBe(true);
  });

  it("MAIL_CHECKS_FAILED bij aanzetten wordt vertaald getoond", async () => {
    const patch = (m: Implementation) => {
      const mail = m.mail as Mutable<typeof m.mail>;
      const orig = mail.status;
      mail.status = async (o) => ({ ...(await (orig as (x: typeof o) => Promise<Awaited<ReturnType<typeof orig>>>)(o)), enabled: false, lastCheck: { checkedAt: new Date(), ok: true, failedRequired: [] } });
    };
    renderWithTrpc(<MailOverview />, { ...en, patch });
    const sw = await screen.findByTestId("mail-toggle");
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sw);
    fireEvent.click(await screen.findByTestId("mail-toggle-confirm"));
    expect(await screen.findByText("Mail can't be turned on while a required system check is red.")).toBeTruthy();
  });

  it("niet ingesteld: uitleg met MAIL_HOSTNAME", async () => {
    const patch = (m: Implementation) => {
      const mail = m.mail as Mutable<typeof m.mail>;
      const orig = mail.status;
      mail.status = async (o) => ({ ...(await (orig as (x: typeof o) => Promise<Awaited<ReturnType<typeof orig>>>)(o)), configured: false });
    };
    renderWithTrpc(<MailOverview />, { ...nl, patch });
    expect(await screen.findByTestId("mail-not-configured")).toBeTruthy();
    expect(screen.getByText("Mail is nog niet ingesteld")).toBeTruthy();
  });
});

describe("Domeinen", () => {
  it("lijst met DNS-badges en mailboxtellers", async () => {
    renderWithTrpc(<MailDomainList />, nl);
    const cards = await screen.findAllByTestId("mail-domain-card");
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByText("DNS klopt")).toBeTruthy();
    expect(within(cards[1]!).getByText("Wacht op DNS")).toBeTruthy();
    expect(within(cards[1]!).getByText("4 / 10 mailboxen")).toBeTruthy();
    expect(within(cards[2]!).getByText("Inactief")).toBeTruthy();
  });

  it("wizard: domein → limieten → DNS-records met kopiëren en opnieuw controleren", async () => {
    const { bodies } = renderWithTrpc(<DomainWizard />, nl);
    const domain = await screen.findByLabelText("Domeinnaam");
    fireEvent.change(domain, { target: { value: "niet geldig" } });
    fireEvent.click(screen.getByTestId("wizard-next"));
    expect(screen.getByText(/Dat lijkt geen domeinnaam/)).toBeTruthy();
    fireEvent.change(domain, { target: { value: "Nieuw.Test" } });
    fireEvent.click(screen.getByTestId("wizard-next"));
    // stap 2: eerste mailbox met gegenereerd wachtwoord
    const create = await screen.findByTestId("wizard-create");
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("password-generate"));
    const pw = (screen.getByLabelText("Wachtwoord") as HTMLInputElement).value;
    expect(pw.length).toBe(20);
    expect(screen.getByTestId("strength-meter").dataset.score).toBe("4");
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(inputs(bodies, "mail.domains.create")).toHaveLength(1));
    expect(inputs(bodies, "mail.domains.create")[0]).toMatchObject({ domain: "nieuw.test", firstMailbox: { localPart: "info", password: pw, quotaMb: 1024 }, postmasterTo: null, maxMailboxes: 0, maxQuotaMb: 0 });
    // stap 3: DNS-records; nooit gecontroleerd → meteen een eerste controle
    expect(await screen.findByText("nieuw.test is toegevoegd")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("dns-progress").textContent).toBe("1 van 6 records kloppen"));
    const mx = screen.getByTestId("dns-record-mx");
    expect(within(mx).getByText("MX")).toBeTruthy();
    fireEvent.click(within(mx).getByRole("button", { name: "Naam nieuw.test kopiëren" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("nieuw.test"));
    expect(within(mx).getByText("Gekopieerd!")).toBeTruthy();
    fireEvent.click(screen.getByTestId("dns-check"));
    await waitFor(() => expect(screen.getByTestId("dns-progress").textContent).toBe("2 van 6 records kloppen"));
    expect(within(screen.getByTestId("dns-record-aaaa")).getByTestId("dns-status").dataset.status).toBe("ok");
    fireEvent.click(screen.getByTestId("wizard-done"));
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/admin\/mail\/domains\/\d+$/));
  });

  it("wizard zonder eerste mailbox vraagt een doeladres voor postmaster@", async () => {
    const { bodies } = renderWithTrpc(<DomainWizard />, en);
    fireEvent.change(await screen.findByLabelText("Domain name"), { target: { value: "other.test" } });
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(await screen.findByTestId("wizard-first-mailbox"));
    const create = screen.getByTestId("wizard-create") as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Forward postmaster@ and abuse@ to"), { target: { value: "ops@panel.test" } });
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(inputs(bodies, "mail.domains.create")[0]).toMatchObject({ domain: "other.test", firstMailbox: null, postmasterTo: "ops@panel.test" }));
  });

  it("bestaand domein: nette foutmelding", async () => {
    renderWithTrpc(<DomainWizard />, nl);
    fireEvent.change(await screen.findByLabelText("Domeinnaam"), { target: { value: "panel.test" } });
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(await screen.findByTestId("password-generate"));
    fireEvent.click(screen.getByTestId("wizard-create"));
    expect(await screen.findByText("Dit maildomein bestaat al.")).toBeTruthy();
  });

  it("Cloudflare: records automatisch instellen", async () => {
    const { bodies } = renderWithTrpc(<DnsRecords domainId={1} auto={false} />, nl);
    // domein 1 is al in orde: geen Cloudflare-knop
    await screen.findByTestId("dns-records");
    expect(screen.getByTestId("dns-progress").textContent).toBe("Alle records kloppen");
    expect(screen.queryByTestId("dns-cloudflare")).toBeNull();
    expect(inputs(bodies, "mail.domains.applyDns")).toEqual([]);
  });
});

describe("Domeindetail", () => {
  it("mailboxen: zoeken, quotabalk en verwijderen pas na het typen van het adres", async () => {
    const { bodies } = renderWithTrpc(<MailDomainDetailView id={1} />, nl);
    expect(await screen.findByRole("heading", { name: "panel.test" })).toBeTruthy();
    const rows = await screen.findAllByTestId("mailbox-row");
    expect(rows).toHaveLength(8);
    expect(within(rows[1]!).getByText("91%")).toBeTruthy();
    fireEvent.change(screen.getByTestId("mailbox-search"), { target: { value: "anna" } });
    expect(screen.getAllByTestId("mailbox-row")).toHaveLength(1);
    fireEvent.change(screen.getByTestId("mailbox-search"), { target: { value: "" } });

    const first = screen.getAllByTestId("mailbox-row")[0]!;
    fireEvent.pointerDown(within(first).getByTestId("mailbox-menu"), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByTestId("mailbox-delete"));
    const dialog = await screen.findByTestId("confirm-delete");
    const go = within(dialog).getByTestId("confirm-go") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByTestId("confirm-input"), { target: { value: "steve@panel" } });
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByTestId("confirm-input"), { target: { value: "steve@panel.test" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(inputs(bodies, "mail.mailboxes.delete")[0]).toEqual({ id: 1 }));
    await waitFor(() => expect(screen.getAllByTestId("mailbox-row")).toHaveLength(7));
  });

  it("mailbox aanmaken: sterktemeter, genereren en daarna de gegevens om te kopiëren", async () => {
    const { bodies } = renderWithTrpc(<MailDomainDetailView id={2} />, nl);
    fireEvent.click(await screen.findByTestId("mailbox-add"));
    const dialog = await screen.findByTestId("mailbox-create");
    fireEvent.change(within(dialog).getByLabelText("Adres"), { target: { value: "sales" } });
    fireEvent.change(within(dialog).getByLabelText("Wachtwoord"), { target: { value: "kort" } });
    expect(within(dialog).getByTestId("strength-meter").dataset.score).toBe("1");
    expect((within(dialog).getByTestId("form-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByTestId("password-generate"));
    fireEvent.click(within(dialog).getByTestId("form-submit"));
    await waitFor(() => expect(inputs(bodies, "mail.mailboxes.create")[0]).toMatchObject({ domainId: 2, localPart: "sales", quotaMb: 1024 }));
    expect(await within(dialog).findAllByText("sales@shop.panel.test is aangemaakt.")).not.toHaveLength(0);
  });

  it("actief-schakelaar werkt de mailbox bij", async () => {
    const { bodies } = renderWithTrpc(<MailDomainDetailView id={1} />, nl);
    fireEvent.click(await screen.findByRole("switch", { name: "info@panel.test actief" }));
    await waitFor(() => expect(inputs(bodies, "mail.mailboxes.update")[0]).toEqual({ id: 2, active: false }));
  });

  it("aliassen: catch-all gemarkeerd, doelen als chips, nieuwe alias met chips-invoer", async () => {
    window.history.replaceState(null, "", "/#aliases");
    const { bodies } = renderWithTrpc(<MailDomainDetailView id={1} />, nl);
    const catchAll = await screen.findByTestId("alias-catchall");
    expect(within(catchAll).getByText("Catch-all")).toBeTruthy();
    expect(within(catchAll).getByText("info@panel.test")).toBeTruthy();
    const sales = screen.getAllByTestId("alias-row").find((r) => r.textContent?.includes("sales@"))!;
    expect(within(sales).getAllByTestId("alias-target")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("alias-add"));
    const dialog = await screen.findByTestId("alias-dialog");
    // er is al een catch-all
    expect((within(dialog).getByRole("radio", { name: /Catch-all/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Adres"), { target: { value: "team" } });
    const goto = within(dialog).getByLabelText("Doorsturen naar");
    fireEvent.change(goto, { target: { value: "geen-adres" } });
    fireEvent.keyDown(goto, { key: "Enter" });
    expect(within(dialog).getByText("geen-adres is geen geldig e-mailadres.")).toBeTruthy();
    fireEvent.change(goto, { target: { value: "anna@panel.test" } });
    fireEvent.keyDown(goto, { key: "Enter" });
    fireEvent.change(goto, { target: { value: "kees@panel.test" } });
    fireEvent.keyDown(goto, { key: "," });
    expect(within(dialog).getAllByTestId("target-chip")).toHaveLength(2);
    fireEvent.click(within(dialog).getByTestId("form-submit"));
    await waitFor(() => expect(inputs(bodies, "mail.aliases.create")[0]).toEqual({ domainId: 1, localPart: "team", goto: ["anna@panel.test", "kees@panel.test"], active: true }));
  });

  it("tabs met pijltjestoetsen; DKIM roteren met bevestiging", async () => {
    const { bodies } = renderWithTrpc(<MailDomainDetailView id={3} />, nl);
    const tab = await screen.findByRole("tab", { name: /Mailboxen/ });
    tab.focus();
    fireEvent.keyDown(tab, { key: "End" });
    expect(screen.getByRole("tab", { name: /DKIM/ }).getAttribute("aria-selected")).toBe("true");
    expect((await screen.findByTestId("dkim-selector")).textContent).toBe("dkim20260901");
    fireEvent.click(screen.getByTestId("dkim-rotate"));
    expect(await screen.findByText("DKIM-sleutel roteren?")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Nieuwe selector (optioneel)"), { target: { value: "mail2026" } });
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => expect(inputs(bodies, "mail.domains.rotateDkim")[0]).toEqual({ id: 3, selector: "mail2026" }));
    await waitFor(() => expect(screen.getByTestId("dkim-selector").textContent).toBe("mail2026"));
    expect(screen.getByText(/Nieuwe sleutel aangemaakt/)).toBeTruthy();
  });

  it("onbekend domein: nette melding", async () => {
    renderWithTrpc(<MailDomainDetailView id={999} />, nl);
    expect(await screen.findByText("Dit maildomein bestaat niet (meer).")).toBeTruthy();
  });
});

describe("Wachtrij", () => {
  it("toont berichten, filtert op uitgesteld en verwijdert met bevestiging", async () => {
    const { bodies } = renderWithTrpc(<MailQueue />, nl);
    expect(await screen.findAllByTestId("queue-row")).toHaveLength(4);
    expect(screen.getByText("Wordt afgeleverd")).toBeTruthy();
    expect(screen.getByText(/Greylisted/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Uitgesteld/ }));
    expect(screen.getAllByTestId("queue-row")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Bericht 4F2A31C0B1 verwijderen" }));
    expect(await screen.findByText("Dit bericht verwijderen?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => expect(inputs(bodies, "mail.queue.delete")[0]).toEqual({ queueId: "4F2A31C0B1" }));
    await waitFor(() => expect(screen.getAllByTestId("queue-row")).toHaveLength(2));
  });

  it("alles opnieuw proberen vraagt bevestiging", async () => {
    const { bodies } = renderWithTrpc(<MailQueue />, en);
    fireEvent.click(await screen.findByTestId("queue-flush"));
    expect(await screen.findByText("Retry all messages now?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => expect(inputs(bodies, "mail.queue.flush")).toHaveLength(1));
    expect(await screen.findByText("Queue flushed.")).toBeTruthy();
  });

  it("lege wachtrij: lege toestand", async () => {
    const patch = (m: Implementation) => {
      (m.mail.queue as Mutable<typeof m.mail.queue>).list = () => [];
    };
    renderWithTrpc(<MailQueue />, { ...nl, patch });
    expect(await screen.findByText("De wachtrij is leeg")).toBeTruthy();
  });

  it("daemon onbereikbaar: vertaalde fout", async () => {
    const { TRPCError } = await import("@trpc/server");
    const patch = (m: Implementation) => {
      (m.mail.queue as Mutable<typeof m.mail.queue>).list = () => {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DAEMON_UNREACHABLE" });
      };
    };
    renderWithTrpc(<MailQueue />, { ...nl, patch });
    expect(await screen.findByText(/De node is nu niet bereikbaar|niet bereikbaar/)).toBeTruthy();
  });
});

describe("hulpfuncties", () => {
  it("wachtwoordsterkte en generator", () => {
    expect(passwordScore("")).toBe(0);
    expect(passwordScore("aaaaaaaaaaaa")).toBe(1);
    expect(passwordScore("Correct-Horse-9")).toBeGreaterThanOrEqual(3);
    const a = generatePassword();
    expect(a).toHaveLength(20);
    expect(passwordScore(a)).toBe(4);
    expect(generatePassword()).not.toBe(a);
  });

  it("relatieve tijd", () => {
    act(() => {});
    const now = Date.now();
    expect(relativeTime(new Date(now - 5 * 60_000), now)).toMatch(/5/);
  });
});
