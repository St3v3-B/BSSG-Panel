// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Implementation } from "@panel/api";
import { AdminDashboard } from "@/app/_components/admin/dashboard";
import { AdminServersList } from "@/app/_components/admin/servers-list";
import { SuspendSection, TemplateSection } from "@/app/_components/admin/server-manage";
import { DatabaseHostsAdmin, DnsProvidersAdmin, SettingsAdmin } from "@/app/_components/admin/settings";
import { UserDetail } from "@/app/_components/admin/user-detail";
import { renderWithTrpc, sessionFor } from "./utils";

afterEach(cleanup);
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const admin = { session: sessionFor("admin"), locale: "en" as const };
const input = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);
const SMP = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";

describe("dashboard", () => {
  it("toont totalen, nodekaart en meldingen", async () => {
    renderWithTrpc(<AdminDashboard />, admin);
    expect(await screen.findByTestId("stat-servers")).toBeTruthy();
    expect(screen.getByTestId("stat-nodes").textContent).toContain("1/1 nodes online");
    expect(screen.getAllByTestId("dash-node")).toHaveLength(1);
    expect(screen.getAllByTestId("alert")[0]!.textContent).toContain("Install failed");
  });

  it("meldt een panel-update en achterlopende nodes", async () => {
    renderWithTrpc(<AdminDashboard />, {
      ...admin,
      patch: (m) => {
        (m.admin.updates as Mutable<typeof m.admin.updates>).summary = () => ({
          panelCommit: "c".repeat(40),
          panelUpdates: 3,
          latest: { sha: "a".repeat(40), date: null, message: "ui: nieuwe dingen" },
          outdatedNodes: [{ id: 1, name: "node1", isLocal: false, commit: "d".repeat(40) }],
          checkedAt: new Date(),
          currentVersion: "0.1.10",
          latestVersion: "0.1.13",
        });
      },
    });
    const panel = await screen.findByTestId("panel-update-notice");
    expect(panel.textContent).toContain("3 panel updates available");
    expect(panel.textContent).toContain("ui: nieuwe dingen");
    expect(within(panel).getByTestId("panel-update-versions").textContent).toBe("0.1.10 → 0.1.13");
    expect(within(panel).getByRole("link").getAttribute("href")).toBe("/admin/settings/updates");
    const nodes = screen.getByTestId("node-update-notice");
    expect(nodes.textContent).toContain("1 node runs an older daemon");
    expect(within(nodes).getByRole("link").getAttribute("href")).toBe("/admin/nodes/1");
    expect(await screen.findByTestId("node-outdated-badge")).toBeTruthy();
  });

  it("niets te melden: geen meldingen", async () => {
    renderWithTrpc(<AdminDashboard />, {
      ...admin,
      patch: (m) => {
        (m.admin.updates as Mutable<typeof m.admin.updates>).summary = () => ({ panelCommit: null, panelUpdates: 0, latest: null, outdatedNodes: [], checkedAt: null, currentVersion: null, latestVersion: null });
      },
    });
    await screen.findByTestId("stat-servers");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("update-notices")).toBeNull();
  });
});

describe("serverlijst", () => {
  it("filters gaan naar de backend", async () => {
    const seen: unknown[] = [];
    renderWithTrpc(<AdminServersList />, {
      ...admin,
      patch: (m) => {
        const orig = m.admin.servers.list;
        (m.admin.servers as Mutable<typeof m.admin.servers>).list = (o) => (seen.push(o.input), orig(o));
      },
    });
    await screen.findAllByTestId("admin-server-row");
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "web" } });
    fireEvent.change(screen.getByLabelText("Suspension"), { target: { value: "true" } });
    await waitFor(() => expect(seen.at(-1)).toMatchObject({ type: "web", suspended: true }));
  });

  it("bulk opschorten: bevestiging en resultaat per server, ook bij een fout", async () => {
    const { bodies } = renderWithTrpc(<AdminServersList />, {
      ...admin,
      patch: (m) => {
        const orig = m.admin.servers.setSuspended;
        (m.admin.servers as Mutable<typeof m.admin.servers>).setSuspended = (o) => {
          if (o.input.uuid !== SMP) throw new Error("daemon weigert");
          return orig(o);
        };
      },
    });
    const rows = await screen.findAllByTestId("admin-server-row");
    fireEvent.click(screen.getByLabelText("Select all"));
    expect(screen.getByText("3 selected")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("bulk-bar")).getByRole("button", { name: "Suspend" }));
    const box = screen.getByTestId("bulk-confirm");
    fireEvent.change(within(box).getByLabelText("Reason (optional)"), { target: { value: "spam" } });
    expect(input(bodies, "admin.servers.setSuspended")).toHaveLength(0); // pas na bevestigen
    fireEvent.click(within(box).getByRole("button", { name: "Confirm" }));
    const res = await screen.findAllByTestId("bulk-result");
    expect(res).toHaveLength(rows.length);
    expect(res.filter((r) => r.dataset.ok === "true")).toHaveLength(1);
    expect(res.some((r) => r.textContent?.includes("Failed"))).toBe(true);
    expect(input(bodies, "admin.servers.setSuspended")[0]).toMatchObject({ suspended: true, reason: "spam" });
  });

  it("snelle actie start één server via servers.power", async () => {
    const { bodies } = renderWithTrpc(<AdminServersList />, admin);
    await screen.findAllByTestId("admin-server-row");
    fireEvent.click(screen.getByLabelText("Restart SMP"));
    await screen.findByTestId("bulk-results");
    expect(input(bodies, "servers.power")).toEqual([{ uuid: SMP, action: "restart" }]);
  });
});

describe("serverpagina", () => {
  it("opschorten met reden en bevestiging", async () => {
    const { bodies } = renderWithTrpc(<SuspendSection uuid={SMP} suspended={null} />, admin);
    const sec = await screen.findByTestId("suspend-section");
    fireEvent.change(within(sec).getByLabelText("Reason"), { target: { value: "betaling" } });
    fireEvent.click(within(sec).getByRole("button", { name: "Suspend server" }));
    expect(input(bodies, "admin.servers.setSuspended")).toHaveLength(0);
    fireEvent.click(within(sec).getAllByRole("button", { name: "Suspend server" })[0]!);
    await waitFor(() => expect(input(bodies, "admin.servers.setSuspended")[0]).toEqual({ uuid: SMP, suspended: true, reason: "betaling" }));
  });

  it("template wisselen met herinstallatie", async () => {
    const { bodies } = renderWithTrpc(<TemplateSection uuid={SMP} type="game" currentName="Paper" />, {
      ...admin,
      patch: (m) => {
        const orig = m.admin.templates.list;
        (m.admin.servers as Mutable<typeof m.admin.servers>).changeTemplate = () => ({ ok: true });
        (m.admin.templates as Mutable<typeof m.admin.templates>).list = (o) => [...(orig(o) as Awaited<ReturnType<typeof orig>>), { id: 9, slug: "folia", name: "Folia", type: "game", version: 1, description: null, serverCount: 0 }] as never;
      },
    });
    const sec = await screen.findByTestId("template-section");
    const select = await within(sec).findByLabelText("New template");
    await within(sec).findByRole("option", { name: /Folia/ });
    expect(within(sec).queryByRole("option", { name: /Static site|Statische/ })).toBeNull(); // ander type
    fireEvent.change(select, { target: { value: "9" } });
    fireEvent.click(within(sec).getByRole("checkbox"));
    fireEvent.click(within(sec).getByRole("button", { name: "Switch template" }));
    fireEvent.click(within(sec).getAllByRole("button", { name: "Switch template" })[0]!);
    await waitFor(() => expect(input(bodies, "admin.servers.changeTemplate")[0]).toEqual({ uuid: SMP, templateId: 9, reinstall: true }));
    expect(await within(sec).findByText("Template switched.")).toBeTruthy();
  });
});

describe("gebruikerspagina", () => {
  it("toont profiel en servers; blokkeren en admin maken", async () => {
    const { bodies } = renderWithTrpc(<UserDetail id={2} />, admin);
    await screen.findByTestId("user-badges");
    expect(screen.getByTestId("user-detail").textContent).toContain("blokgenoot");
    fireEvent.click(screen.getByRole("button", { name: /^Block$/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Block$/ })[0]!);
    await waitFor(() => expect(input(bodies, "admin.users.setBlocked")[0]).toEqual({ id: 2, blocked: true }));
    fireEvent.click(await screen.findByRole("button", { name: /Make admin/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /Make admin/ })[0]!);
    await waitFor(() => expect(input(bodies, "admin.admins.add")[0]).toEqual({ discordId: "100000000000000002" }));
  });

  it("de eigenaar kan niet worden teruggezet", async () => {
    renderWithTrpc(<UserDetail id={1} />, admin);
    const btn = await screen.findByRole("button", { name: /Remove admin/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/can't be blocked or demoted/)).toBeTruthy();
  });
});

describe("instellingen", () => {
  it("opslaan stuurt alle velden; ongeldige kleur wordt geweigerd", async () => {
    const { bodies } = renderWithTrpc(<SettingsAdmin />, admin);
    const name = (await screen.findByLabelText("Panel name")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Mijn Panel" } });
    fireEvent.change(screen.getByLabelText("Logo URL"), { target: { value: "https://panel.test/logo.png" } });
    fireEvent.change(screen.getByLabelText("Memory (MB)"), { target: { value: "1024" } });
    fireEvent.change(document.getElementById("set-accent")!, { target: { value: "rood" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByRole("alert").textContent).toMatch(/color/);
    expect(input(bodies, "admin.settings.update")).toHaveLength(0);
    fireEvent.change(document.getElementById("set-accent")!, { target: { value: "#aa00ff" } });
    expect((screen.getByTestId("accent-preview").querySelector("span[style]") as HTMLElement).style.color).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Settings saved.")).toBeTruthy();
    expect(input(bodies, "admin.settings.update")[0]).toMatchObject({ panelName: "Mijn Panel", logoUrl: "https://panel.test/logo.png", accentColor: "#aa00ff", defaultLimits: { ramMb: 1024 } });
  });
});

describe("bewaartermijn activiteitenlog", () => {
  it("standaard 90; 0 = altijd; ongeldig wordt geweigerd; opslaan stuurt activityRetentionDays", async () => {
    const { bodies } = renderWithTrpc(<SettingsAdmin />, admin);
    const days = (await screen.findByLabelText("Keep activity log (days)")) as HTMLInputElement;
    expect(days.value).toBe("90");
    fireEvent.change(days, { target: { value: "-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(input(bodies, "admin.settings.update")).toHaveLength(0);
    fireEvent.change(days, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Settings saved.")).toBeTruthy();
    expect(input(bodies, "admin.settings.update")[0]).toMatchObject({ activityRetentionDays: 0 });
  });
});

describe("MOTD van slapende servers", () => {
  it("voorbeeld rendert Minecraft-kleuren en opslaan stuurt sleepMotd", async () => {
    const { bodies } = renderWithTrpc(<SettingsAdmin />, admin);
    const promo = (await screen.findByLabelText(/Promo line/)) as HTMLInputElement;
    fireEvent.change(promo, { target: { value: "&#ff8800Hello &lWorld&r!" } });
    const spans = Array.from(screen.getByTestId("motd-line2").querySelectorAll("span")) as HTMLElement[];
    expect(spans.map((x) => x.textContent)).toEqual(["Hello ", "World", "!"]);
    expect(spans[0]!.style.color).toBe("rgb(255, 136, 0)");
    expect(spans[1]!.style.fontWeight).toBe("700");
    expect(spans[2]!.style.color).toBe("rgb(255, 255, 255)");
    fireEvent.click(screen.getByLabelText(/Set the BSSG logo as server-icon\.png/));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Settings saved.")).toBeTruthy();
    expect(input(bodies, "admin.settings.update")[0]).toMatchObject({ sleepMotd: { promo: "&#ff8800Hello &lWorld&r!", showLogoIcon: true, seedLogoIcon: false } });
  });
});

describe("database-hosts en DNS-providers", () => {
  it("host toevoegen, testen", async () => {
    const { bodies } = renderWithTrpc(<DatabaseHostsAdmin />, admin);
    await screen.findAllByTestId("db-host");
    fireEvent.click(screen.getByRole("button", { name: /Add host/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "extra" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db2.test" } });
    fireEvent.change(screen.getByLabelText("Admin password"), { target: { value: "geheim" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(input(bodies, "admin.databaseHosts.create")[0]).toMatchObject({ name: "extra", host: "db2.test", port: 3306, adminUser: "root", adminPassword: "geheim", nodeId: null }));
    fireEvent.click(screen.getAllByRole("button", { name: "Test connection" })[0]!);
    expect(await screen.findByText("Connection works.")).toBeTruthy();
  });

  it("DNS-provider toevoegen en zones verversen", async () => {
    const { bodies } = renderWithTrpc(<DnsProvidersAdmin />, admin);
    fireEvent.click(await screen.findByRole("button", { name: /Add provider/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "cf" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(input(bodies, "admin.dnsProviders.create")[0]).toEqual({ type: "cloudflare", name: "cf", apiToken: "tok" }));
    const refresh = (await screen.findAllByRole("button", { name: /Refresh zones/ }))[0]!;
    fireEvent.click(refresh);
    await waitFor(() => expect(input(bodies, "admin.dnsProviders.refreshZones")).toHaveLength(1));
  });
});
