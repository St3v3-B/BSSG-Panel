// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerDetail } from "@panel/api";
import { ActiveAlarms, AlarmDefaultsCard } from "@/app/_components/admin/alarms";
import { AlarmsCard } from "@/app/_components/server/alarms-card";
import { CloneCard } from "@/app/_components/server/clone-card";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
beforeAll(() => {
  process.env.NEXT_PUBLIC_PANEL_MOCK = "1";
});
afterEach(cleanup);

const GAME = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6"; // eigenaar admin (1), online
const USER_GAME = "3a1d9b7c-5e6f-4a8b-9c0d-112233445566"; // eigenaar gebruiker (2)
const SITE = "c0ffee00-1234-4abc-8def-0123456789ab"; // website van de admin
const admin = { session: sessionFor("admin"), locale: "en" as const };
const user = { session: sessionFor("user"), locale: "en" as const };
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

async function loadServer(uuid: string, role: "admin" | "user" = "admin"): Promise<ServerDetail> {
  const { buildRouter } = await import("@panel/api");
  const { createMock } = await import("@panel/api/mock");
  const caller = buildRouter(createMock()).createCaller({ session: sessionFor(role), ip: null, userAgent: null, resHeaders: new Headers() } as never);
  return (await caller.servers.get({ uuid })) as ServerDetail;
}

describe("server dupliceren", () => {
  it("gebruiker: quotum, poorten, opmerkingen; starten toont de voortgang en kan afbreken", async () => {
    const { bodies } = renderWithTrpc(<CloneCard server={await loadServer(USER_GAME, "user")} />, user);
    fireEvent.click(screen.getByTestId("clone-open"));
    const form = await screen.findByTestId("clone-form");
    expect(screen.getByTestId("clone-quota").textContent).toMatch(/Left in your quota/);
    expect(form.textContent).toMatch(/new port\(s\)/);
    // Geen keuze voor eigenaar/node voor gebruikers.
    expect(within(form).queryByLabelText("Owner")).toBeNull();
    expect((screen.getByLabelText("Name of the copy") as HTMLInputElement).value).toMatch(/\(copy\)$/);
    fireEvent.change(screen.getByLabelText("Memory (MB)"), { target: { value: "12" } });
    expect((screen.getByTestId("clone-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Memory (MB)"), { target: { value: "1024" } });
    fireEvent.change(screen.getByLabelText("Name of the copy"), { target: { value: "Staging" } });
    fireEvent.click(screen.getByTestId("clone-submit"));
    const progress = await screen.findByTestId("clone-progress");
    expect(inputs(bodies, "servers.clone")[0]).toMatchObject({ uuid: USER_GAME, name: "Staging", limits: { ramMb: 1024 }, copyDatabases: false, domain: null, startAfter: false });
    expect(inputs(bodies, "servers.clone")[0]).not.toHaveProperty("ownerId");
    expect(progress.textContent).toMatch(/Copy files/);
    fireEvent.click(screen.getByTestId("clone-cancel"));
    await waitFor(() => expect(screen.getByTestId("clone-progress").getAttribute("data-status")).toBe("canceled"));
    expect(screen.getByText("The copy was canceled and removed.")).toBeTruthy();
  });

  it("zonder quotum: uitleg in plaats van het formulier", async () => {
    renderWithTrpc(<CloneCard server={await loadServer(USER_GAME, "user")} />, {
      ...user,
      patch: (m) => {
        const srv = m.servers as { -readonly [K in keyof typeof m.servers]: (typeof m.servers)[K] };
        const orig = srv.cloneOptions;
        srv.cloneOptions = async (o: Parameters<typeof orig>[0]) => ({ ...(await orig(o)), allowed: false, quota: null });
      },
    });
    fireEvent.click(screen.getByTestId("clone-open"));
    expect((await screen.findByTestId("clone-no-quota")).textContent).toMatch(/don't have a quota/);
    expect(screen.queryByTestId("clone-form")).toBeNull();
  });

  it("admin, website: databases mee (met duidelijke waarschuwing), domein, eigenaar en node", async () => {
    const { bodies } = renderWithTrpc(<CloneCard server={await loadServer(SITE)} />, { session: sessionFor("admin") });
    fireEvent.click(screen.getByTestId("clone-open"));
    await screen.findByTestId("clone-form");
    // Nederlands: databases staan standaard aan, met de waarschuwing over configbestanden.
    expect((screen.getByTestId("clone-copy-db") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("clone-db-warning").textContent).toMatch(/wijzen na het kopiëren nog naar de oorspronkelijke database/);
    fireEvent.change(screen.getByLabelText("Nieuw domein (optioneel)"), { target: { value: "niet geldig" } });
    expect((screen.getByTestId("clone-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Nieuw domein (optioneel)"), { target: { value: "Staging.Example.test" } });
    await waitFor(() => expect(screen.getByLabelText("Eigenaar").querySelectorAll("option").length).toBeGreaterThan(1));
    const owner = screen.getByLabelText("Eigenaar") as HTMLSelectElement;
    fireEvent.change(owner, { target: { value: owner.options[1]!.value } });
    fireEvent.click(screen.getByTestId("clone-submit"));
    await screen.findByTestId("clone-progress");
    const sent = inputs(bodies, "servers.clone")[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ uuid: SITE, copyDatabases: true, domain: "staging.example.test", ownerId: Number(owner.options[1]!.value) });
    expect(sent).not.toHaveProperty("nodeId"); // zelfde node
    expect(sent).not.toHaveProperty("limits"); // ongewijzigd
    expect(screen.getByTestId("clone-progress").textContent).toMatch(/Gekopieerde databases/);
    expect(screen.getByTestId("clone-progress").textContent).toMatch(/s1_wordpress/);
  });
});

describe("verbruiksalarmen", () => {
  it("eigenaar: eigen drempels, foutcontrole, offline-melding; standaard terug", async () => {
    const { bodies } = renderWithTrpc(<AlarmsCard uuid={USER_GAME} />, user);
    const card = await screen.findByTestId("alarms-card");
    expect(card.textContent).toMatch(/Panel default: CPU > 90%/);
    fireEvent.click(screen.getByTestId("alarms-defaults"));
    fireEvent.change(screen.getByLabelText("CPU above (% of limit)"), { target: { value: "5" } });
    expect(screen.getByText("Enter 10 to 100, or leave empty for off.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save alarms/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("CPU above (% of limit)"), { target: { value: "85" } });
    fireEvent.change(screen.getByLabelText("Disk above (% of limit)"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("For at least (minutes)"), { target: { value: "15" } });
    fireEvent.click(screen.getByTestId("alarms-offline"));
    fireEvent.click(screen.getByRole("button", { name: /Save alarms/ }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(inputs(bodies, "servers.updateAlarms")[0]).toEqual({ uuid: USER_GAME, notifyOffline: false, config: { enabled: true, cpuPct: 85, ramPct: 90, diskPct: null, durationMinutes: 15 } });
    fireEvent.click(screen.getByTestId("alarms-defaults"));
    fireEvent.click(screen.getByTestId("alarms-offline"));
    fireEvent.click(screen.getByRole("button", { name: /Save alarms/ }));
    await waitFor(() => expect(inputs(bodies, "servers.updateAlarms")[1]).toEqual({ uuid: USER_GAME, notifyOffline: true, config: null }));
  });

  it("actieve alarmen zichtbaar op de server en in het admin-dashboard", async () => {
    renderWithTrpc(<AlarmsCard uuid={GAME} />, admin);
    expect((await screen.findByTestId("alarms-active")).textContent).toMatch(/Memory: 93% \(alarm at 90%\)/);
    cleanup();
    renderWithTrpc(<ActiveAlarms />, admin);
    const rows = await screen.findAllByTestId("active-alarm");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.textContent).toMatch(/Memory/);
  });

  it("admin: standaardwaarden en cooldown opslaan", async () => {
    const { bodies } = renderWithTrpc(<AlarmDefaultsCard />, admin);
    await screen.findByTestId("alarm-defaults");
    fireEvent.change(screen.getByLabelText("Cooldown (minutes)"), { target: { value: "2" } });
    expect(screen.getByText("Enter 5 to 1440 minutes.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Cooldown (minutes)"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Memory above (% of limit)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(inputs(bodies, "admin.alarms.setDefaults")[0]).toEqual({ enabled: true, cpuPct: 90, ramPct: null, diskPct: 90, durationMinutes: 10, cooldownMinutes: 120 });
  });
});
