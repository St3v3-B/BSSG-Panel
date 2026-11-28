// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ImporterAdmin } from "@/app/_components/admin/importer";
import { NodeDetail } from "@/app/_components/admin/nodes";
import { MaintenanceNotice } from "@/app/_components/maintenance-notice";
import { fromLocalInput, toLocalInput } from "@/app/_lib/amsterdam-time";
import { LocaleProvider } from "@/app/_lib/i18n";
import { renderWithTrpc, sessionFor } from "./utils";

afterEach(cleanup);
const admin = { session: sessionFor("admin"), locale: "en" as const };
const input = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

describe("Europe/Amsterdam in datetime-local", () => {
  it("winter- en zomertijd heen en terug", () => {
    expect(fromLocalInput("2026-12-01T23:00")!.toISOString()).toBe("2026-12-01T22:00:00.000Z");
    expect(fromLocalInput("2026-07-01T12:30")!.toISOString()).toBe("2026-07-01T10:30:00.000Z");
    expect(toLocalInput(new Date("2026-07-01T10:30:00Z"))).toBe("2026-07-01T12:30");
    expect(toLocalInput(null)).toBe("");
    expect(fromLocalInput("")).toBeNull();
  });
});

describe("onderhoudsmodus (node-detail)", () => {
  it("aanzetten met planning, badge, servers kiezen en evacuatie starten", async () => {
    const { bodies } = renderWithTrpc(<NodeDetail id={1} onDeleted={() => {}} />, admin);
    const card = await screen.findByTestId("node-maintenance");
    fireEvent.change(within(card).getByLabelText(/Message for owners/), { target: { value: "Nieuwe schijven" } });
    fireEvent.change(within(card).getByLabelText("Planned start"), { target: { value: "2026-12-01T23:00" } });
    fireEvent.change(within(card).getByLabelText("Planned end"), { target: { value: "2026-12-01T22:00" } });
    expect(within(card).getByText("The end must be after the start.")).toBeTruthy();
    fireEvent.change(within(card).getByLabelText("Planned end"), { target: { value: "2026-12-02T03:00" } });
    fireEvent.click(within(card).getByRole("button", { name: "Start maintenance" }));
    await waitFor(() => expect(input(bodies, "admin.maintenance.set")).toHaveLength(1));
    expect(input(bodies, "admin.maintenance.set")[0]).toMatchObject({ id: 1, message: "Nieuwe schijven", plannedStart: new Date("2026-12-01T22:00:00Z"), plannedEnd: new Date("2026-12-02T02:00:00Z"), notifyOwners: true });
    await screen.findAllByText("Maintenance");
    // evacueren: één server uitvinken, één handmatig doel
    fireEvent.click(await screen.findByTestId("evac-plan"));
    const planner = await screen.findByTestId("evac-planner");
    const boxes = within(planner).getAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThan(1);
    fireEvent.click(boxes[0]!);
    const selects = within(planner).getAllByRole("combobox");
    fireEvent.change(selects[1]!, { target: { value: "99" } });
    fireEvent.change(within(planner).getByLabelText("At the same time"), { target: { value: "2" } });
    fireEvent.click(within(planner).getByTestId("evac-start"));
    await waitFor(() => expect(input(bodies, "admin.maintenance.evacuate")).toHaveLength(1));
    const sent = input(bodies, "admin.maintenance.evacuate")[0] as { concurrency: number; items: Array<{ nodeId: number | null }> };
    expect(sent.concurrency).toBe(2);
    expect(sent.items).toHaveLength(boxes.length - 1);
    expect(sent.items[0]!.nodeId).toBe(99);
    expect(sent.items.slice(1).every((i) => i.nodeId === null)).toBe(true);
    const progress = await screen.findByTestId("evac-progress");
    expect(within(progress).getAllByTestId("evac-item")).toHaveLength(boxes.length - 1);
    expect(within(progress).getByRole("button", { name: /Cancel the rest/ })).toBeTruthy();
  });
});

describe("banner voor eigenaren", () => {
  it("toont begin en eind en het bericht; niets zonder onderhoud", () => {
    const { container } = render(
      <LocaleProvider initial="nl">
        <MaintenanceNotice maintenance={{ since: new Date("2026-11-30T10:00:00Z"), message: "Nieuwe schijven", plannedStart: new Date("2026-12-01T22:00:00Z"), plannedEnd: new Date("2026-12-02T02:00:00Z") }} />
        <MaintenanceNotice maintenance={null} />
      </LocaleProvider>,
    );
    const n = screen.getByTestId("maintenance-notice");
    expect(n.textContent).toMatch(/Deze node is in onderhoud van .*23:00.* tot .*03:00/);
    expect(n.textContent).toContain("Nieuwe schijven");
    expect(container.querySelectorAll("[data-testid=maintenance-notice]")).toHaveLength(1);
  });
});

describe("import-wizard", () => {
  it("verbinden, mapping aanpassen, proefrun en starten", async () => {
    const { bodies } = renderWithTrpc(<ImporterAdmin />, admin);
    const form = await screen.findByTestId("import-connect");
    const submit = within(form).getByTestId("import-connect-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Panel URL"), { target: { value: "https://ptero.panel.test" } });
    fireEvent.change(within(form).getByLabelText("Application API key"), { target: { value: "ptla_abcdefghijkl" } });
    fireEvent.change(within(form).getByLabelText("SFTP user (panel username)"), { target: { value: "steve" } });
    fireEvent.change(within(form).getByLabelText("SFTP password"), { target: { value: "geheim" } });
    fireEvent.click(submit);
    await screen.findByTestId("import-session");
    expect(input(bodies, "admin.importer.connect")[0]).toMatchObject({ kind: "pterodactyl", url: "https://ptero.panel.test", apiKey: "ptla_abcdefghijkl", clientApiKey: null, sftp: { username: "steve", password: "geheim", host: null, port: null } });

    // eggs: TS3 aan een template koppelen
    const eggs = await screen.findAllByTestId("import-egg");
    expect(eggs).toHaveLength(2);
    expect(within(eggs[0]!).getByText(/Suggestion: Paper \(85%\)/)).toBeTruthy();
    await waitFor(() => expect(within(eggs[1]!).getAllByRole("option").length).toBeGreaterThan(1));
    const tplOption = within(eggs[1]!).getAllByRole("option")[1] as HTMLOptionElement;
    fireEvent.change(within(eggs[1]!).getByRole("combobox"), { target: { value: tplOption.value } });
    await waitFor(() => expect(input(bodies, "admin.importer.setMapping")).toHaveLength(1));
    expect(input(bodies, "admin.importer.setMapping")[0]).toEqual({ eggs: [{ id: 7, action: "template", templateId: Number(tplOption.value) }] });
    // omzetten toont YAML
    fireEvent.click(within(eggs[1]!).getByRole("button", { name: /Convert/ }));
    expect(((await screen.findByLabelText("YAML")) as HTMLTextAreaElement).value).toContain("slug: egg-teamspeak3-server");

    // gebruikers: de overgeslagen gebruiker aanmaken met Discord-ID
    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    const users = await screen.findAllByTestId("import-user");
    fireEvent.change(within(users[2]!).getByRole("combobox"), { target: { value: "create" } });
    fireEvent.change(within(users[2]!).getByLabelText("Discord ID"), { target: { value: "300000000000000099" } });
    fireEvent.click(within(users[2]!).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(input(bodies, "admin.importer.setMapping")).toHaveLength(2));
    expect(input(bodies, "admin.importer.setMapping")[1]).toEqual({ users: [{ id: 3, action: "create", accountId: null, discordId: "300000000000000099" }] });

    // servers: één uitzetten
    fireEvent.click(screen.getByRole("tab", { name: "Servers" }));
    const servers = await screen.findAllByTestId("import-server");
    fireEvent.click(within(servers[2]!).getByRole("checkbox"));
    await waitFor(() => expect(input(bodies, "admin.importer.setMapping")).toHaveLength(3));

    // proefrun
    fireEvent.click(screen.getByRole("tab", { name: "Dry run" }));
    const plan = await screen.findByTestId("import-plan");
    await waitFor(() => expect(within(plan).getAllByTestId("plan-server")).toHaveLength(2));
    expect(within(plan).getByText(/new account 300000000000000003/)).toBeTruthy();
    expect(within(plan).getByText(/Skipped: TS3 \(excluded\)/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("import-start"));
    await waitFor(() => expect(input(bodies, "admin.importer.start")).toHaveLength(1));
    expect(await screen.findByText("Importing")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop after this server/ })).toBeTruthy();
  });

  it("Nederlands: tabs en knoppen vertaald", async () => {
    renderWithTrpc(<ImporterAdmin />, { ...admin, locale: "nl" });
    const form = await screen.findByTestId("import-connect");
    expect(within(form).getByText("Verbinden met de bron")).toBeTruthy();
    expect(within(form).getByRole("button", { name: /Verbinden en inlezen/ })).toBeTruthy();
  });
});
