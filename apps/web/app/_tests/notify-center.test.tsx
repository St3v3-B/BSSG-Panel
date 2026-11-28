// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SmtpSettingsCard } from "@/app/_components/admin/smtp-settings";
import { NotificationBell, NotificationSettingsCards } from "@/app/_components/notifications/notification-center";
import { PublicStatusView } from "@/app/_components/status/public-status";
import { ServerStatusPageCard, StatusPagesManager } from "@/app/_components/status/status-page-settings";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/", useParams: () => ({}), useSearchParams: () => new URLSearchParams() }));
beforeAll(() => {
  process.env.NEXT_PUBLIC_PANEL_MOCK = "1";
});
afterEach(cleanup);

const GAME = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
const en = (role: "admin" | "user" = "admin") => ({ session: sessionFor(role), locale: "en" as const });
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

describe("bel met meldingen", () => {
  it("toont het aantal ongelezen, de lijst en alles gelezen", async () => {
    const { bodies } = renderWithTrpc(<NotificationBell />, en());
    expect((await screen.findByTestId("unread-count")).textContent).toBe("2");
    fireEvent.pointerDown(screen.getByTestId("notification-bell"), { button: 0, ctrlKey: false });
    const items = await screen.findAllByTestId("inbox-item");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("Server crashed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Mark all as read/ }));
    await waitFor(() => expect(inputs(bodies, "inbox.markRead")).toEqual([{}]));
    await waitFor(() => expect(screen.queryByTestId("unread-count")).toBeNull());
  });
});

describe("meldingsinstellingen op het account", () => {
  it("zonder SMTP: e-mail niet beschikbaar; voorkeuren per gebeurtenis opslaan; admin-gebeurtenissen alleen voor admins", async () => {
    const { bodies } = renderWithTrpc(<NotificationSettingsCards isAdmin={false} />, en("user"));
    expect(await screen.findByText(/E-mail is not set up on this panel yet/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send confirmation link" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Node offline (admin)")).toBeNull();
    const box = screen.getByLabelText("Server crashed: E-mail") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(inputs(bodies, "account.setNotificationPrefs")).toEqual([{ prefs: { server_crashed: { panel: true, discord: true, email: false } } }]));
    await waitFor(() => expect((screen.getByLabelText("Server crashed: E-mail") as HTMLInputElement).checked).toBe(false));
  });

  it("voorkeur aanvinken verandert meteen (optimistisch), ook als de server traag is", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    renderWithTrpc(<NotificationSettingsCards isAdmin={false} />, {
      ...en("user"),
      patch: (m) => {
        const orig = m.account.setNotificationPrefs;
        m.account.setNotificationPrefs = async (a) => (await gate, orig(a));
      },
    });
    const box = (await screen.findByLabelText("Backup completed: Panel")) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect((screen.getByLabelText("Backup completed: Panel") as HTMLInputElement).checked).toBe(true));
    release();
    await waitFor(() => expect((screen.getByLabelText("Backup completed: Panel") as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByLabelText("Backup completed: Panel") as HTMLInputElement).checked).toBe(true);
  });

  it("admin ziet admin-gebeurtenissen; e-mailadres zetten stuurt een link", async () => {
    const { bodies } = renderWithTrpc(
      <>
        <SmtpSettingsCard />
        <NotificationSettingsCards isAdmin />
      </>,
      en(),
    );
    expect(await screen.findByText("Node offline (admin)")).toBeTruthy();
    // eerst SMTP instellen (admin)
    fireEvent.change(await screen.findByLabelText("Host"), { target: { value: "smtp.panel.test" } });
    fireEvent.change(screen.getByLabelText("Sender address"), { target: { value: "panel@panel.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "geheim" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(inputs(bodies, "admin.smtp.set")[0]).toMatchObject({ host: "smtp.panel.test", port: 587, security: "starttls", password: "geheim", from: "panel@panel.test" }));
    // na opslaan is het wachtwoordveld leeg en staat er een hint
    expect(await screen.findByText("Leave empty to keep the current password")).toBeTruthy();
  });

  it("SMTP opslaan: de melding 'SMTP settings saved.' blijft staan na het opnieuw opbouwen van het formulier", async () => {
    renderWithTrpc(<SmtpSettingsCard />, en());
    fireEvent.change(await screen.findByLabelText("Host"), { target: { value: "smtp.panel.test" } });
    fireEvent.change(screen.getByLabelText("Sender address"), { target: { value: "panel@panel.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("SMTP settings saved.")).toBeTruthy();
    // het testmail-formulier verschijnt (host gezet) en de melding staat er nog
    expect(await screen.findByLabelText("Send a test e-mail to")).toBeTruthy();
    expect(screen.getByText("SMTP settings saved.")).toBeTruthy();
  });

  it("e-mailadres: ongeldig geblokkeerd, geldig verstuurt een bevestigingslink", async () => {
    const { bodies } = renderWithTrpc(<NotificationSettingsCards isAdmin={false} />, {
      ...en("user"),
      patch: (m) => {
        const set = m.admin.smtp.set;
        void set({ input: { host: "smtp.panel.test", port: 587, security: "starttls", username: null, from: "p@panel.test", fromName: null }, ctx: { session: sessionFor("admin"), ip: null, userAgent: null, resHeaders: new Headers() } });
      },
    });
    const input = (await screen.findByLabelText("E-mail address")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "geen-adres" } });
    expect(screen.getByText("Not a valid e-mail address.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "speler@panel.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Send confirmation link" }));
    expect(await screen.findByText(/Confirmation link sent/)).toBeTruthy();
    expect(inputs(bodies, "account.setEmail")).toEqual([{ email: "speler@panel.test" }]);
    expect(await screen.findByText(/Waiting for confirmation of speler@panel.test/)).toBeTruthy();
  });
});

describe("statuspagina's", () => {
  it("serverkaart: slug controleren, adres standaard uit, opslaan", async () => {
    const { bodies } = renderWithTrpc(<ServerStatusPageCard uuid={GAME} name="SMP" />, en());
    const slug = (await screen.findByLabelText("Address")) as HTMLInputElement;
    expect(slug.value).toBe("smp");
    fireEvent.change(slug, { target: { value: "-x" } });
    expect(screen.getByText(/Use 3 to 48 lowercase letters/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(slug, { target: { value: "smp-status" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(inputs(bodies, "statusPages.setServerPage")).toEqual([{ uuid: GAME, enabled: true, slug: "smp-status", showAddress: true, showPlayers: true }]));
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("serverkaart zonder bestaande pagina: na de eerste keer opslaan blijft 'Saved.' staan (geen remount)", async () => {
    let first = true;
    renderWithTrpc(<ServerStatusPageCard uuid={GAME} name="SMP" />, {
      ...en(),
      patch: (m) => {
        const orig = m.statusPages.serverPage;
        m.statusPages.serverPage = (a) => (first ? ((first = false), null) : orig(a));
      },
    });
    const slug = (await screen.findByLabelText("Address")) as HTMLInputElement;
    fireEvent.change(slug, { target: { value: "smp-nieuw" } });
    fireEvent.click(screen.getByRole("switch", { name: "Status page on" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Open page" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText("Saved.")).toBeTruthy();
  });

  it("netwerkpagina maken met servers in volgorde", async () => {
    const { bodies } = renderWithTrpc(<StatusPagesManager />, en());
    fireEvent.click(await screen.findByTestId("new-status-page"));
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Ons Netwerk" } });
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("ons-netwerk");
    const pick = screen.getByLabelText("Add a server…") as HTMLSelectElement;
    const opts = [...pick.options].filter((o) => o.value);
    fireEvent.change(pick, { target: { value: opts[1]!.value } });
    fireEvent.change(screen.getByLabelText("Add a server…"), { target: { value: opts[0]!.value } });
    expect(screen.getAllByTestId("sp-server")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Move up" })[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(inputs(bodies, "statusPages.create")[0]).toMatchObject({ slug: "ons-netwerk", title: "Ons Netwerk", serverUuids: [opts[0]!.value, opts[1]!.value], showAddress: false }));
    await waitFor(() => expect(screen.getAllByTestId("status-page-row")).toHaveLength(2));
  });

  it("openbare weergave: staat, spelers, uptime, geen adres als het niet gedeeld wordt", () => {
    renderWithTrpc(
      <PublicStatusView
        status={{
          title: "SMP",
          description: "Onze server",
          kind: "network",
          branding: { panelName: "Panel", logoUrl: null, accentColor: "#22c55e" },
          overall: "degraded",
          updatedAt: new Date(),
          servers: [
            { name: "Lobby", type: "game", state: "online", players: { online: 3, max: 20 }, uptime24h: 99.5, uptime7d: 100, hours: Array(24).fill(100), days: Array(7).fill(100), address: null },
            { name: "Site", type: "web", state: "offline", players: null, uptime24h: null, uptime7d: null, hours: Array(24).fill(null), days: Array(7).fill(null), address: "site.panel.test" },
          ],
        }}
      />,
      en(),
    );
    expect(screen.getByTestId("overall").textContent).toContain("Some servers are not available");
    const rows = screen.getAllByTestId("public-server");
    expect(within(rows[0]!).getByText("3 / 20 players")).toBeTruthy();
    expect(within(rows[0]!).getByText("99.50%")).toBeTruthy();
    expect(within(rows[0]!).queryByText(/panel\.test/)).toBeNull();
    expect(within(rows[1]!).getByText("Offline")).toBeTruthy();
    expect(within(rows[1]!).getByText("site.panel.test")).toBeTruthy();
    expect(within(rows[1]!).getAllByText("no data").length).toBe(2);
  });
});
