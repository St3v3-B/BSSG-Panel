// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentProfile, type ServerDetail } from "@panel/api";
import { bedrockPlatform } from "@panel/api/network";
import { playersPlatform } from "@panel/api/players";
import { AllocationsAdmin } from "@/app/_components/admin/nodes";
import { CreateServerForm } from "@/app/_components/create-server-form";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { getT } from "@/app/_lib/i18n";
import { portSuffix } from "@/app/_lib/ports";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
afterEach(cleanup);
const admin = { session: sessionFor("admin"), locale: "en" as const };

describe("Steam-games in de UI", () => {
  it("geen Spelers-, Bedrock- of content-tab voor de nieuwe templates", () => {
    const base = { uuid: "u", type: "game" as const, isOwner: true, permissions: ["players.read", "files.read", "files.write", "console.read"] as ServerDetail["permissions"] };
    for (const slug of ["valheim", "satisfactory", "palworld", "rust", "cs2", "terraria"]) {
      const keys = serverTabs({ ...base, players: !!playersPlatform(slug), bedrock: !!bedrockPlatform(slug), content: contentProfile(slug)?.kind ?? null }).map((t) => t.key);
      expect(keys, slug).not.toContain("players");
      expect(keys, slug).not.toContain("bedrock");
      expect(keys, slug).not.toContain("content");
      expect(keys, slug).toContain("console");
    }
  });

  it("portSuffix: protocol en rol, niets voor een gewone poort", () => {
    const t = getT();
    expect(portSuffix({ protocol: "udp", label: "Steam query" }, t)).toBe(` (${t.ports.udp}, Steam query)`);
    expect(portSuffix({ protocol: "both", label: null }, t)).toBe("");
    expect(portSuffix({ protocol: "tcp", label: null }, t)).toBe(` (${t.ports.tcp})`);
  });

  it("allocations toevoegen met protocol UDP", async () => {
    const { bodies } = renderWithTrpc(<AllocationsAdmin nodeId={1} />, admin);
    await screen.findAllByTestId("allocation");
    fireEvent.change(screen.getByLabelText("IP address"), { target: { value: "203.0.113.10" } });
    fireEvent.change(screen.getByLabelText("Ports"), { target: { value: "2456-2457" } });
    fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "udp" } });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    expect(await screen.findByText("2 allocations added.")).toBeTruthy();
    expect(bodies.find((b) => b.path === "admin.allocations.create")!.input).toEqual({ nodeId: 1, ip: "203.0.113.10", ports: "2456-2457", protocol: "udp" });
    await waitFor(() => expect(screen.getAllByTestId("allocation").filter((a) => a.textContent?.includes("UDP")).map((a) => a.querySelector("code")!.textContent)).toEqual(["203.0.113.10:2456", "203.0.113.10:2457"]));
  });

  it("aanmaakformulier: poorten van de template en aanbevolen limieten", async () => {
    renderWithTrpc(<CreateServerForm onCreated={() => {}} />, admin);
    await screen.findByTestId("create-server-form");
    const tpl = (await screen.findByLabelText("Template")) as HTMLSelectElement;
    fireEvent.change(tpl, { target: { value: "3" } });
    const ports = await screen.findByTestId("template-ports");
    expect(ports.textContent).toContain("Steam query");
    expect(ports.textContent).toContain("QUERY_PORT");
    expect(ports.textContent).toContain("primary +1");
    const disk = screen.getByLabelText(/Disk/) as HTMLInputElement;
    expect(disk.value).not.toBe("4096");
    fireEvent.click(screen.getByRole("button", { name: "Use recommended limits" }));
    expect(disk.value).toBe("4096");
    // Paper beschrijft geen poorten: geen poortenblok
    fireEvent.change(tpl, { target: { value: "1" } });
    await waitFor(() => expect(screen.queryByTestId("template-ports")).toBeNull());
  });
});
