// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Implementation, PlayersInfo, ServerDetail } from "@panel/api";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { PlayersManager } from "@/app/_components/server/players-manager";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
afterEach(cleanup);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const UUID = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6"; // SMP (Paper, online) uit de mock
const ALL = ["players.read", "players.manage"] as ServerDetail["permissions"];
const server = (o: Partial<ServerDetail> = {}) => ({ uuid: UUID, name: "SMP", type: "game", templateName: "Paper", templateSlug: "paper", isOwner: true, permissions: ALL, ...o }) as unknown as ServerDetail;
const admin = { session: sessionFor("admin"), locale: "en" as const };
const manageInputs = (bodies: Array<{ path: string; input: unknown }>) => bodies.filter((b) => b.path === "players.manage").map((b) => (b.input as { op: unknown }).op);
const patchInfo = (over: Partial<PlayersInfo>) => (m: Implementation) => {
  const orig = m.players.info;
  (m.players as Mutable<typeof m.players>).info = async (a) => ({ ...(await orig(a as never)), ...over });
};

describe("tabblad Spelers", () => {
  const base = { uuid: UUID, type: "game" as const, isOwner: false, permissions: ["players.read"] as ServerDetail["permissions"] };
  it("alleen voor Minecraft en met players.read", () => {
    expect(serverTabs({ ...base, players: true }).map((t) => t.key)).toContain("players");
    expect(serverTabs({ ...base, players: false }).map((t) => t.key)).not.toContain("players");
    expect(serverTabs({ ...base, players: true, permissions: ["console.read"] }).map((t) => t.key)).not.toContain("players");
  });
});

describe("PlayersManager", () => {
  it("toont online spelers met initialen (geen externe avatars), aantal en Bedrock-badge", async () => {
    renderWithTrpc(<PlayersManager server={server()} />, admin);
    const list = await screen.findByTestId("players-online");
    expect(within(list).getByText("Steve")).toBeTruthy();
    expect(within(list).getByText(".PocketPlayer")).toBeTruthy();
    expect(within(list).getByText("Bedrock")).toBeTruthy();
    expect(screen.getByTestId("players-count").textContent).toBe("3 / 20");
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(within(list).getAllByTestId("player-avatar")[0]!.textContent).toBe("S");
  });

  it("whitelist: naam toevoegen, ongeldige naam geweigerd, aan/uit", async () => {
    const { bodies } = renderWithTrpc(<PlayersManager server={server()} />, admin);
    await screen.findByTestId("whitelist");
    const input = screen.getAllByLabelText("Player name")[0]!;
    const add = screen.getAllByRole("button", { name: "Add" })[0]! as HTMLButtonElement;
    fireEvent.change(input, { target: { value: "bad name;op" } });
    expect(add.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/letters, digits or underscores/);
    fireEvent.change(input, { target: { value: "Notch" } });
    fireEvent.click(add);
    await waitFor(() => expect(manageInputs(bodies)).toEqual([{ action: "whitelistAdd", name: "Notch" }]));
    expect(await within(screen.getByTestId("whitelist")).findByText("Notch")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on whitelist" }));
    await waitFor(() => expect(screen.getByTestId("whitelist-state").textContent).toBe("On"));
    fireEvent.click(screen.getByRole("button", { name: "Remove Alex" }));
    await waitFor(() => expect(manageInputs(bodies).at(-1)).toEqual({ action: "whitelistRemove", name: "Alex" }));
  });

  it("Bedrock-naam (punt) alleen met Floodgate", async () => {
    renderWithTrpc(<PlayersManager server={server()} />, { ...admin, patch: patchInfo({ floodgate: false }) });
    await screen.findByTestId("whitelist");
    const input = screen.getAllByLabelText("Player name")[0]!;
    fireEvent.change(input, { target: { value: ".Pocket" } });
    expect((screen.getAllByRole("button", { name: "Add" })[0] as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const { bodies } = renderWithTrpc(<PlayersManager server={server()} />, admin);
    await screen.findByTestId("whitelist");
    fireEvent.change(screen.getAllByLabelText("Player name")[0]!, { target: { value: ".Pocket" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
    await waitFor(() => expect(manageInputs(bodies)).toEqual([{ action: "whitelistAdd", name: ".Pocket" }]));
  });

  it("kicken en bannen met reden via de dialoog; reden met regeleinde geweigerd", async () => {
    const { bodies } = renderWithTrpc(<PlayersManager server={server()} />, admin);
    await screen.findByTestId("players-online");
    fireEvent.click(screen.getByRole("button", { name: "Kick Alex" }));
    const reason = await screen.findByLabelText("Reason (optional)", { selector: "[role=dialog] input" });
    fireEvent.change(reason, { target: { value: "AFK" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Kick" }));
    await waitFor(() => expect(manageInputs(bodies)).toEqual([{ action: "kick", name: "Alex", reason: "AFK" }]));

    fireEvent.click(await screen.findByRole("button", { name: "Ban Steve" }));
    const r2 = await screen.findByLabelText("Reason (optional)", { selector: "[role=dialog] input" });
    fireEvent.change(r2, { target: { value: "a\tstop" } }); // \n strippen tekstvelden zelf al
    expect((within(screen.getByRole("dialog")).getByRole("button", { name: "Ban" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(r2, { target: { value: "Griefing" } });
    fireEvent.click(screen.getByLabelText("Also ban their IP address"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Ban" }));
    await waitFor(() => expect(manageInputs(bodies).slice(1)).toEqual([{ action: "banIp", target: "Steve", reason: "Griefing" }, { action: "ban", name: "Steve", reason: "Griefing" }]));
  });

  it("operators en IP-bans: deop, pardon-ip, ongeldig IP geweigerd bij een gestopte server", async () => {
    const { bodies } = renderWithTrpc(<PlayersManager server={server()} />, { ...admin, patch: patchInfo({ running: false }) });
    expect(await screen.findByTestId("players-stopped-note")).toBeTruthy();
    const ip = screen.getByLabelText("IP address");
    fireEvent.change(ip, { target: { value: "Steve" } });
    expect((screen.getByRole("button", { name: "Ban IP" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove operator Steve" }));
    await waitFor(() => expect(manageInputs(bodies)).toEqual([{ action: "deop", name: "Steve" }]));
    fireEvent.click(screen.getByRole("button", { name: "Unban 198.51.100.23" }));
    await waitFor(() => expect(manageInputs(bodies).at(-1)).toEqual({ action: "pardonIp", ip: "198.51.100.23" }));
  });

  it("alleen players.read: lijsten zichtbaar, geen beheerknoppen", async () => {
    renderWithTrpc(<PlayersManager server={server({ isOwner: false, permissions: ["players.read"] })} />, admin);
    await screen.findByTestId("whitelist");
    expect(screen.queryByLabelText("Player name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn on whitelist" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Kick/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("serverfout wordt vertaald", async () => {
    renderWithTrpc(<PlayersManager server={server()} />, {
      ...admin,
      patch: (m) => {
        (m.players as Mutable<typeof m.players>).manage = () => {
          throw Object.assign(new Error("PLAYER_NOT_FOUND"), { code: "PRECONDITION_FAILED" });
        };
      },
    });
    await screen.findByTestId("whitelist");
    fireEvent.change(screen.getAllByLabelText("Player name")[0]!, { target: { value: "Nobody_1" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
    expect((await screen.findByTestId("players-error")).textContent).toMatch(/No Minecraft account/);
  });

  it("Velocity: online per backend, uitleg, geen whitelist", async () => {
    renderWithTrpc(<PlayersManager server={server({ uuid: "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6", templateSlug: "velocity", templateName: "Velocity" })} />, {
      ...admin,
      patch: (m) => {
        (m.players as Mutable<typeof m.players>).info = () => ({ supported: true, platform: "proxy", running: true, onlineMode: true, floodgate: false, whitelistEnabled: false, whitelist: [], ops: [], bans: [], ipBans: [] });
        (m.players as Mutable<typeof m.players>).online = () => ({ running: true, online: 1, max: 500, players: [{ name: "Steve", uuid: null, server: "lobby" }], complete: true, source: "console" });
      },
    });
    expect(await screen.findByText("on lobby")).toBeTruthy();
    expect(screen.getByText(/managed on the servers behind it/)).toBeTruthy();
    expect(screen.queryByTestId("whitelist-state")).toBeNull();
  });

  it("geen Minecraft: melding", async () => {
    renderWithTrpc(<PlayersManager server={server({ templateSlug: "java-generic" })} />, { ...admin, patch: patchInfo({ supported: false }) });
    expect((await screen.findByTestId("players-unsupported")).textContent).toMatch(/server.properties/);
  });

  it("smal scherm: rijen kunnen krimpen (min-w-0 + truncate), geen vaste breedtes", async () => {
    renderWithTrpc(<PlayersManager server={server()} />, admin);
    const rows = await screen.findAllByTestId("player-row");
    for (const r of rows) {
      expect(r.className).toContain("min-w-0");
      expect(r.innerHTML).not.toMatch(/\bw-\[\d{3,}px\]|min-w-\[\d{3,}px\]/);
    }
  });
});
