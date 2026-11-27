// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import type { Implementation, ServerDetail } from "@panel/api";
import { UserDetail } from "@/app/_components/admin/user-detail";
import { DeleteOwnCard, OwnLimitsCard } from "@/app/_components/quota/own-server-cards";
import { NewServerForm } from "@/app/_components/quota/new-server-form";
import { QuotaUsageTable } from "@/app/_components/quota/quota-usage";
import OverviewPage from "@/app/(panel)/page";
import { renderWithTrpc, sessionFor } from "./utils";

const push = vi.fn();
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  push.mockClear();
});
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const user = { session: sessionFor("user"), locale: "en" as const };
const admin = { session: sessionFor("admin"), locale: "en" as const };
const input = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

describe("overzicht", () => {
  it("gebruiker met quotum ziet de knop en verbruik; admin zonder quotum niet", async () => {
    renderWithTrpc(<OverviewPage />, user);
    expect(await screen.findByRole("link", { name: /New server/ })).toBeTruthy();
    expect((await screen.findByTestId("quota-ram")).textContent).toContain("2048");
    expect(screen.getByTestId("quota-ram").textContent).toContain("4096");
    cleanup();
    renderWithTrpc(<OverviewPage />, admin);
    await screen.findByTestId("server-list");
    expect(screen.queryByRole("link", { name: /New server/ })).toBeNull();
  });
});

describe("overzicht: alle servers voor admins", () => {
  afterEach(() => localStorage.clear());
  it("admin wisselt naar alle servers (onthouden), gebruiker ziet de schakelaar niet", async () => {
    renderWithTrpc(<OverviewPage />, admin);
    const mineCount = (await screen.findByTestId("server-list")).children.length;
    const allBtn = await screen.findByRole("button", { name: "All servers" });
    expect(screen.getByRole("button", { name: "Mine" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(allBtn);
    await waitFor(() => expect(screen.getByTestId("server-list").children.length).toBeGreaterThan(mineCount));
    expect(allBtn.getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByRole("heading", { name: "All servers" })).toBeTruthy();
    expect(localStorage.getItem("panel_servers_scope")).toBe("all");
    cleanup();
    renderWithTrpc(<OverviewPage />, user);
    await screen.findByTestId("quota-card");
    expect(screen.queryByTestId("server-scope")).toBeNull();
  });
});

describe("nieuwe server", () => {
  it("toont restruimte, blokkeert boven het quotum en stuurt de limieten mee", async () => {
    const { bodies } = renderWithTrpc(<NewServerForm />, user);
    const ram = (await screen.findByRole("spinbutton", { name: "Memory (MB)" })) as HTMLInputElement;
    expect(screen.getAllByText("Up to 2048").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mijn server" } });
    fireEvent.change(ram, { target: { value: "5000" } });
    expect((screen.getByRole("button", { name: /Create server/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(ram, { target: { value: "1024" } });
    fireEvent.click(screen.getByRole("button", { name: /Create server/ }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(input(bodies, "servers.create")[0]).toMatchObject({ name: "Mijn server", limits: { ramMb: 1024 }, ports: 1 });
  });

  it("zonder quotum een melding", async () => {
    renderWithTrpc(<NewServerForm />, admin);
    expect((await screen.findByText(/don't have a quota/)).textContent).toBeTruthy();
  });
});

const owned = { uuid: "3a1d9b7c-5e6f-4a8b-9c0d-112233445566", name: "Creative", limits: { cpuPct: 100, ramMb: 2048, swapMb: 0, diskMb: 10000 } } as ServerDetail;

describe("eigen server", () => {
  it("limieten binnen quotum worden opgeslagen, erboven geblokkeerd", async () => {
    const { bodies } = renderWithTrpc(<OwnLimitsCard server={owned} />, user);
    const ram = (await screen.findByLabelText("Memory (MB)")) as HTMLInputElement;
    fireEvent.change(ram, { target: { value: "99999" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(ram, { target: { value: "1024" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(input(bodies, "servers.updateOwnLimits")[0]).toMatchObject({ uuid: owned.uuid, limits: { ramMb: 1024 } }));
  });

  it("verwijderen vraagt de naam", async () => {
    const { bodies } = renderWithTrpc(<DeleteOwnCard server={owned} />, user);
    const btn = screen.getByRole("button", { name: "Delete this server" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type "Creative"/), { target: { value: "creative" } });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type "Creative"/), { target: { value: "Creative" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect(input(bodies, "servers.deleteOwn")[0]).toEqual({ uuid: owned.uuid, confirmName: "Creative" });
  });

  it("serverfout wordt getoond", async () => {
    renderWithTrpc(<NewServerForm />, {
      ...user,
      patch: (m: Implementation) => {
        (m.servers as Mutable<typeof m.servers>).create = () => {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "QUOTA_EXCEEDED: ram" });
        };
      },
    });
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /Create server/ }));
    expect((await screen.findByText(/more than your quota/)).textContent).toBeTruthy();
  });
});

describe("admin", () => {
  it("quota-editor op de gebruikerspagina: instellen en weghalen", async () => {
    const { bodies, calls } = renderWithTrpc(<UserDetail id={2} />, admin);
    const ram = (await screen.findByLabelText("Memory (MB)")) as HTMLInputElement;
    expect(ram.value).toBe("4096");
    fireEvent.change(ram, { target: { value: "8192" } });
    fireEvent.click(screen.getByRole("button", { name: "Save quota" }));
    await waitFor(() => expect(input(bodies, "admin.users.setQuota")[0]).toMatchObject({ id: 2, maxRamMb: 8192, maxServers: 3, templateIds: null }));
    // Na het opslaan laadt getQuota opnieuw en wordt het formulier opnieuw opgebouwd (key); pas
    // daarna klikken, anders zet die remount het vinkje terug en is de test timing-afhankelijk.
    await waitFor(() => expect(calls.filter((c) => c.includes("admin.users.getQuota")).length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    await waitFor(() => expect((screen.getByLabelText("Memory (MB)") as HTMLInputElement).value).toBe("8192"), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.click(screen.getByLabelText("Allow this user to create servers"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove quota" }));
    await waitFor(() => expect(input(bodies, "admin.users.clearQuota")[0]).toEqual({ id: 2 }), { timeout: 5000 });
  });

  it("verbruik per gebruiker", async () => {
    renderWithTrpc(<QuotaUsageTable />, admin);
    const row = (await screen.findAllByRole("row")).find((r) => r.textContent?.includes("blokgenoot"))!;
    expect(row.textContent).toMatch(/\/ 3/);
  });
});
