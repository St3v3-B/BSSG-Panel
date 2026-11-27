// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerDetail } from "@panel/api";
import { DomainsAllowedSection } from "@/app/_components/admin/server-manage";
import { DomainManager } from "@/app/_components/domains/domain-manager";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
afterEach(cleanup);

const GAME = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
const admin = { session: sessionFor("admin"), locale: "en" as const };
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

describe("game-server domeinen", () => {
  it("tabblad Domains alleen als admin het toestaat", () => {
    const base = { uuid: GAME, type: "game", isOwner: true, permissions: ["domain.manage"] } as const satisfies Pick<ServerDetail, "uuid" | "type" | "isOwner" | "permissions">;
    expect(serverTabs({ ...base, domainsAllowed: false }).map((t) => t.key)).not.toContain("domains");
    expect(serverTabs({ ...base, domainsAllowed: true }).map((t) => t.key)).toContain("domains");
  });

  it("HTTP: poort verplicht, met hint; verstuurt protocol http + targetPort", async () => {
    const { bodies } = renderWithTrpc(<DomainManager uuid={GAME} isWeb={false} />, admin);
    fireEvent.change(await screen.findByLabelText("Domain"), { target: { value: "map.example.com" } });
    expect(screen.getByText(/e\.g\. 8123 for BlueMap\/Dynmap/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    expect(await screen.findByText("Enter a port between 1 and 65535")).toBeTruthy();
    expect(inputs(bodies, "domains.add")).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "8123" } });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    await waitFor(() => expect(inputs(bodies, "domains.add")).toHaveLength(1));
    expect(inputs(bodies, "domains.add")[0]).toEqual({ uuid: GAME, hostname: "map.example.com", protocol: "http", targetPort: 8123 });
    expect((await screen.findByTestId("domain-protocol")).textContent).toBe("HTTP → port 8123");
  });

  it("Minecraft: geen poortveld, legt uit dat het domein genoeg is, geen SSL-badge", async () => {
    const { bodies } = renderWithTrpc(<DomainManager uuid={GAME} isWeb={false} />, admin);
    fireEvent.change(await screen.findByLabelText("Type"), { target: { value: "minecraft" } });
    expect(screen.queryByLabelText("Port")).toBeNull();
    expect(screen.getByText(/join with just the domain/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "play.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    await waitFor(() => expect(inputs(bodies, "domains.add")).toHaveLength(1));
    expect(inputs(bodies, "domains.add")[0]).toEqual({ uuid: GAME, hostname: "play.example.com", protocol: "minecraft" });
    expect((await screen.findByTestId("domain-protocol")).textContent).toBe("Minecraft address");
    expect(screen.queryByTestId("ssl-status")).toBeNull();
  });

  it("admin-schakelaar: aanzetten meteen, uitzetten na bevestiging", async () => {
    const { bodies } = renderWithTrpc(<DomainsAllowedSection uuid={GAME} allowed={false} />, admin);
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(inputs(bodies, "admin.servers.setDomainsAllowed")).toEqual([{ uuid: GAME, allowed: true }]));
    cleanup();
    const r = renderWithTrpc(<DomainsAllowedSection uuid={GAME} allowed />, admin);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(inputs(r.bodies, "admin.servers.setDomainsAllowed")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Turn off and remove domains/ }));
    await waitFor(() => expect(inputs(r.bodies, "admin.servers.setDomainsAllowed")).toEqual([{ uuid: GAME, allowed: false }]));
  });
});
