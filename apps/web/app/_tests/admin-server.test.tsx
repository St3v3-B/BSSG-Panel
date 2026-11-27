// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerDetail } from "@panel/api";
import { DeleteServerCard, LimitsCard, MoveNodeCard, OwnerCard, PortsCard } from "@/app/_components/admin/server-manage";
import { VariablesCard } from "@/app/_components/server/server-settings";
import AdminServersPage from "@/app/(panel)/admin/servers/page";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/admin", useParams: () => ({}) }));

afterEach(cleanup);
const GAME = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
const admin = { session: sessionFor("admin"), locale: "en" as const };
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

async function loadServer(uuid = GAME): Promise<ServerDetail> {
  const { buildRouter } = await import("@panel/api");
  const { createMock } = await import("@panel/api/mock");
  const caller = buildRouter(createMock()).createCaller({ session: sessionFor("admin"), ip: null, userAgent: null, resHeaders: new Headers() } as never);
  return (await caller.servers.get({ uuid })) as ServerDetail;
}

describe("admin: server beheren", () => {
  it("serverlijst linkt naar /admin/servers/<uuid>", async () => {
    renderWithTrpc(<AdminServersPage />, admin);
    const rows = await screen.findAllByTestId("admin-server-row");
    expect(within(rows[0]!).getByRole("link", { name: "SMP" }).getAttribute("href")).toBe(`/admin/servers/${GAME}`);
  });

  it("limieten: controle en opslaan", async () => {
    const { bodies } = renderWithTrpc(<LimitsCard server={await loadServer()} />, admin);
    const ram = screen.getByLabelText("Memory (MB)");
    fireEvent.change(ram, { target: { value: "10" } });
    expect(screen.getByText("Too low")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save limits/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(ram, { target: { value: "6144" } });
    fireEvent.click(screen.getByRole("button", { name: /Save limits/ }));
    expect(await screen.findByText("Limits saved.")).toBeTruthy();
    expect(inputs(bodies, "admin.servers.updateLimits")[0]).toEqual({ uuid: GAME, limits: { cpuPct: 200, ramMb: 6144, swapMb: 0, diskMb: 20000 } });
  });

  it("eigenaar wijzigen via zoeken, en vooraf aanmaken op Discord-ID", async () => {
    const { bodies } = renderWithTrpc(<OwnerCard server={await loadServer()} />, admin);
    fireEvent.change(screen.getByLabelText("Change owner"), { target: { value: "blok" } });
    fireEvent.click(await screen.findByRole("option", { name: /blokgenoot/ }));
    fireEvent.click(screen.getByRole("button", { name: /Make owner: blokgenoot/ }));
    expect(await screen.findByText("Owner changed.")).toBeTruthy();
    expect(inputs(bodies, "admin.servers.updateOwner")[0]).toEqual({ uuid: GAME, ownerId: 2 });

    fireEvent.change(screen.getByLabelText("Change owner"), { target: { value: "123456789012345678" } });
    fireEvent.click(await screen.findByRole("button", { name: /Create in advance/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Make owner: Discord 123456789012345678/ }));
    await waitFor(() => expect(inputs(bodies, "admin.servers.updateOwner")).toHaveLength(2));
  });

  it("poorten: vrije poort toevoegen en primair maken", async () => {
    const { bodies } = renderWithTrpc(<PortsCard server={await loadServer()} />, admin);
    const opts = await screen.findAllByTestId("port-option");
    expect(opts.map((o) => o.textContent)).toEqual([expect.stringContaining("25565"), expect.stringContaining("25567"), expect.stringContaining("25568")]);
    fireEvent.click(screen.getByLabelText("203.0.113.10:25567"));
    fireEvent.click(within(opts[1]!).getByRole("button", { name: "Make primary" }));
    fireEvent.click(screen.getByRole("button", { name: /Save ports/ }));
    expect(await screen.findByText(/Ports saved/)).toBeTruthy();
    expect(inputs(bodies, "admin.servers.updateAllocations")[0]).toEqual({ uuid: GAME, allocationIds: [3, 1] });
  });

  it("verplaatsen naar een andere node: bevestigen en transfer aanroepen", async () => {
    const server = await loadServer();
    const { bodies } = renderWithTrpc(<MoveNodeCard server={server} />, {
      ...admin,
      patch: (m) => {
        const list = m.admin.nodes.list;
        (m.admin.nodes as { list: unknown }).list = (async (o: never) => [...(await list(o)), { id: 2, name: "node2", fqdn: "node2.test", daemonPort: 8080, sftpPort: 2023, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null, diskQuotaMode: "soft", isLocal: false, supportsDomains: true, publicPort: 443, publicIp: null, joinState: null }]) as never;
      },
    });
    const sel = (await screen.findByLabelText("Target node")) as HTMLSelectElement;
    await waitFor(() => expect(sel.options.length).toBeGreaterThan(0));
    expect(Array.from(sel.options).every((o) => o.value !== String(server.node.id))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move server" }));
    fireEvent.click(await screen.findByRole("button", { name: "Move server" }));
    expect(await screen.findByText("Server moved.")).toBeTruthy();
    expect(screen.getByText(/needs a restart/)).toBeTruthy();
    expect(inputs(bodies, "admin.servers.transfer")[0]).toEqual({ uuid: GAME, nodeId: Number(sel.value) });
  });

  it("variabelen: admin ziet ook niet-aanpasbare", async () => {
    const base = await loadServer();
    const server = { ...base, variables: [...base.variables, { key: "JAVA_FLAGS", name: "Java flags", description: null, value: "-Xmx1G", default: "", userEditable: false, pattern: null }] };
    const { bodies } = renderWithTrpc(<VariablesCard server={server} all />, admin);
    expect(screen.getByText("(admin only)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Java flags/), { target: { value: "-Xmx2G" } });
    fireEvent.click(screen.getByRole("button", { name: /Save variables/ }));
    await waitFor(() => expect(inputs(bodies, "servers.updateVariables")[0]).toEqual({ uuid: GAME, variables: { JAVA_FLAGS: "-Xmx2G" } }));
  });

  it("verwijderen pas na het intypen van de naam", async () => {
    const onDeleted = vi.fn();
    const { bodies } = renderWithTrpc(<DeleteServerCard server={await loadServer()} onDeleted={onDeleted} />, admin);
    fireEvent.click(screen.getByRole("button", { name: /Delete server…/ }));
    const go = screen.getByRole("button", { name: /Delete permanently/ }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type “SMP”/), { target: { value: "smp" } });
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type “SMP”/), { target: { value: "SMP" } });
    fireEvent.click(go);
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(inputs(bodies, "admin.servers.delete")[0]).toEqual({ uuid: GAME });
  });
});
