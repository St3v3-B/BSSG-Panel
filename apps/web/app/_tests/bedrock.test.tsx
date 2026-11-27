// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BedrockStatus, Implementation, ServerDetail } from "@panel/api";
import { BedrockManager } from "@/app/_components/server/bedrock-manager";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
afterEach(cleanup);

const UUID = "11111111-1111-4111-8111-111111111111";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const admin = { session: sessionFor("admin"), locale: "en" as const };
const server = { uuid: UUID, name: "Paper", permissions: [], isOwner: true } as unknown as ServerDetail;
const off: BedrockStatus = { supported: true, mode: "standalone", enabled: false, address: null, port: null, allocationId: null, freeAllocations: [{ id: 7, ip: "203.0.113.10", port: 19132 }, { id: 8, ip: "203.0.113.10", port: 19133 }] };
const on: BedrockStatus = { ...off, enabled: true, address: "203.0.113.10", port: 19132, allocationId: 7, freeAllocations: [] };
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);
const patch = (st: BedrockStatus) => (m: Implementation) => {
  (m.servers as Mutable<typeof m.servers>).bedrock = () => st;
};

describe("tabblad Bedrock", () => {
  const base = { uuid: UUID, type: "game" as const, isOwner: true, permissions: [] as ServerDetail["permissions"] };
  it("alleen als de template het ondersteunt, voor de eigenaar", () => {
    expect(serverTabs({ ...base, bedrock: true }).map((t) => t.key)).toContain("bedrock");
    expect(serverTabs({ ...base }).map((t) => t.key)).not.toContain("bedrock");
    expect(serverTabs({ ...base, isOwner: false, bedrock: true }).map((t) => t.key)).not.toContain("bedrock");
  });
});

describe("BedrockManager", () => {
  it("uit: kies de poort en zet aan", async () => {
    const { bodies } = renderWithTrpc(<BedrockManager server={server} />, { ...admin, patch: patch(off) });
    expect((await screen.findByTestId("bedrock-state")).textContent).toBe("Off");
    fireEvent.change(screen.getByLabelText("Bedrock port"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on Bedrock" }));
    await waitFor(() => expect(inputs(bodies, "servers.setBedrock")).toHaveLength(1));
    expect(inputs(bodies, "servers.setBedrock")[0]).toEqual({ uuid: UUID, enabled: true, allocationId: 8, restart: true });
  });

  it("aan: toont adres, poort en de firewall-melding (UDP); uitzetten", async () => {
    const { bodies } = renderWithTrpc(<BedrockManager server={server} />, { ...admin, patch: patch(on) });
    expect((await screen.findByTestId("bedrock-host")).textContent).toBe("203.0.113.10");
    expect(screen.getByTestId("bedrock-port").textContent).toBe("19132");
    expect(screen.getByTestId("bedrock-firewall").textContent).toMatch(/UDP port 19132/);
    fireEvent.click(screen.getByRole("button", { name: "Turn off Bedrock" }));
    await waitFor(() => expect(inputs(bodies, "servers.setBedrock")).toHaveLength(1));
    expect(inputs(bodies, "servers.setBedrock")[0]).toEqual({ uuid: UUID, enabled: false, restart: true });
  });

  it("geen vrije poort: melding en geen knop", async () => {
    renderWithTrpc(<BedrockManager server={server} />, { ...admin, patch: patch({ ...off, freeAllocations: [] }) });
    expect(await screen.findByTestId("bedrock-nofree")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Turn on Bedrock" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("achter een proxy: uitleg, geen schakelaar", async () => {
    renderWithTrpc(<BedrockManager server={server} />, { ...admin, patch: patch({ ...off, supported: false, mode: "backend" }) });
    expect(await screen.findByText("Bedrock runs through the proxy")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on Bedrock" })).toBeNull();
  });
});
