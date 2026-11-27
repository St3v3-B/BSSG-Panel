// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Implementation, ServerDetail } from "@panel/api";
import { NetworkManager } from "@/app/_components/server/network-manager";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
afterEach(cleanup);

const PROXY = "11111111-1111-4111-8111-111111111111";
const A = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
const B = "3a1d9b7c-5e6f-4a8b-9c0d-112233445566";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const admin = { session: sessionFor("admin"), locale: "en" as const };
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

const cand = (uuid: string, name: string, suggestedName: string, takenBy: string | null = null) => ({ uuid, name, templateName: "Paper", address: "203.0.113.10:25565", ownerName: "steve", suggestedName, takenBy });
const proxy = (members: ServerDetail["network"]["members"] = []): ServerDetail => ({
  ...({ uuid: PROXY, name: "Proxy", permissions: [], isOwner: true } as unknown as ServerDetail),
  network: { role: "proxy", members, proxy: null, connectAddress: "play.example.com" },
});
const patch = (list: ReturnType<typeof cand>[]) => (m: Implementation) => {
  (m.servers as Mutable<typeof m.servers>).networkCandidates = () => list;
};

describe("tabblad Network", () => {
  const base = { uuid: PROXY, type: "game" as const, isOwner: true, permissions: [] as ServerDetail["permissions"] };
  it("alleen op een proxy, voor de eigenaar", () => {
    expect(serverTabs({ ...base, network: { role: "proxy" } }).map((t) => t.key)).toContain("network");
    expect(serverTabs({ ...base, network: { role: "backend" } }).map((t) => t.key)).not.toContain("network");
    expect(serverTabs({ ...base }).map((t) => t.key)).not.toContain("network");
    expect(serverTabs({ ...base, isOwner: false, network: { role: "proxy" } }).map((t) => t.key)).not.toContain("network");
  });
});

describe("NetworkManager", () => {
  it("toont verbindingsadres en waarschuwing; kiezen, naam en standaard, bevestigen en resultaat", async () => {
    const { bodies } = renderWithTrpc(<NetworkManager server={proxy()} />, { ...admin, patch: patch([cand(A, "SMP", "smp"), cand(B, "Creative World", "creative-world")]) });
    expect((await screen.findByTestId("network-connect")).textContent).toBe("play.example.com");
    expect(screen.getByText(/only reachable through the proxy/)).toBeTruthy();
    // niets gekozen: opslaan kan (leeg netwerk), maar kies er twee
    fireEvent.click(await screen.findByLabelText("Add SMP to the network"));
    fireEvent.click(screen.getByLabelText("Add Creative World to the network"));
    expect((screen.getByLabelText("Name for SMP") as HTMLInputElement).value).toBe("smp");
    fireEvent.change(screen.getByLabelText("Name for Creative World"), { target: { value: "creative" } });
    fireEvent.click(screen.getByLabelText("Make Creative World the default server"));
    fireEvent.click(screen.getByRole("button", { name: "Save network" }));
    expect(inputs(bodies, "servers.updateNetwork")).toHaveLength(0); // eerst bevestigen
    const confirm = await screen.findByTestId("network-confirm");
    expect(confirm.textContent).toContain("Proxy, SMP, Creative World");
    fireEvent.click(screen.getByRole("button", { name: "Save and restart" }));
    await waitFor(() => expect(inputs(bodies, "servers.updateNetwork")).toHaveLength(1));
    expect(inputs(bodies, "servers.updateNetwork")[0]).toEqual({
      uuid: PROXY,
      restart: true,
      members: [{ serverUuid: A, name: "smp", isDefault: false }, { serverUuid: B, name: "creative", isDefault: true }],
    });
  });

  it("ongeldige of dubbele naam blokkeert opslaan; server achter andere proxy is uitgeschakeld", async () => {
    renderWithTrpc(<NetworkManager server={proxy()} />, { ...admin, patch: patch([cand(A, "SMP", "smp"), cand(B, "Other", "other", "Proxy 2")]) });
    expect(((await screen.findByLabelText("Add Other to the network")) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Already behind Proxy 2")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Add SMP to the network"));
    fireEvent.change(screen.getByLabelText("Name for SMP"), { target: { value: "Bad Name" } });
    expect(screen.getByText("Use lowercase letters, digits and dashes only.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save network" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("toont per server het resultaat na opslaan", async () => {
    const { findAllByTestId } = renderWithTrpc(<NetworkManager server={proxy()} />, {
      ...admin,
      patch: (m) => {
        patch([cand(A, "SMP", "smp")])(m);
        (m.servers as Mutable<typeof m.servers>).updateNetwork = () => ({ servers: [{ uuid: A, name: "SMP", role: "backend", restarted: false, error: null }, { uuid: PROXY, name: "Proxy", role: "proxy", restarted: false, error: "boom" }] });
      },
    });
    fireEvent.click(await screen.findByLabelText("Add SMP to the network"));
    fireEvent.click(screen.getByRole("button", { name: "Save network" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save without restarting" }));
    const rows = await findAllByTestId("network-result-row");
    expect(rows[0]!.textContent).toContain("Not restarted; applies at the next start");
    expect(rows[1]!.textContent).toContain("Restart failed: boom");
  });

  it("bestaande leden staan aangevinkt, in volgorde", async () => {
    renderWithTrpc(<NetworkManager server={proxy([{ serverUuid: B, serverName: "Creative", name: "lobby", isDefault: true, address: null }])} />, {
      ...admin,
      patch: patch([cand(A, "SMP", "smp"), cand(B, "Creative", "creative")]),
    });
    expect(((await screen.findByLabelText("Add Creative to the network")) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Name for Creative") as HTMLInputElement).value).toBe("lobby");
    expect(((screen.getByLabelText("Add SMP to the network")) as HTMLInputElement).checked).toBe(false);
  });
});
