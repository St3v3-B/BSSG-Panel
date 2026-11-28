// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Implementation, PlayerSession, ServerDetail } from "@panel/api";
import { PlayerActivityView, timelineRows } from "@/app/_components/server/player-activity";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
afterEach(cleanup);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const SMP = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6"; // Paper, online
const SITE = "c0ffee00-1234-4abc-8def-0123456789ab"; // website
const admin = { session: sessionFor("admin"), locale: "en" as const };
const nl = { session: sessionFor("admin"), locale: "nl" as const };

describe("tabblad Activiteit", () => {
  const base = { uuid: SMP, type: "game" as const, isOwner: false, permissions: ["players.read"] as ServerDetail["permissions"] };
  it("alleen voor Minecraft en met players.read", () => {
    expect(serverTabs({ ...base, players: true }).map((t) => t.key)).toEqual(expect.arrayContaining(["players", "activity"]));
    expect(serverTabs({ ...base, players: false }).map((t) => t.key)).not.toContain("activity");
    expect(serverTabs({ ...base, players: true, permissions: ["console.read"] }).map((t) => t.key)).not.toContain("activity");
  });
});

describe("timelineRows", () => {
  it("groepeert per speler (hoofdletterongevoelig), meeste speeltijd eerst, begrensd tot het venster", () => {
    const from = new Date("2026-11-27T00:00:00Z");
    const to = new Date("2026-11-28T00:00:00Z");
    const s = (id: number, name: string, a: string, b: string | null): PlayerSession => ({ id, name, uuid: null, joinedAt: new Date(a), leftAt: b ? new Date(b) : null, endReason: b ? "leave" : null });
    const rows = timelineRows([s(1, "Alex", "2026-11-27T10:00:00Z", "2026-11-27T11:00:00Z"), s(2, "Steve", "2026-11-26T22:00:00Z", "2026-11-27T02:00:00Z"), s(3, "steve", "2026-11-27T23:00:00Z", null)], from, to);
    expect(rows.map((r) => [r.name, r.total / 3600_000, r.sessions.length])).toEqual([["Steve", 3, 2], ["Alex", 1, 1]]);
  });
});

describe("PlayerActivityView", () => {
  it("toont huidige spelers, tijdlijn met markeringen, heatmap en spelerstabel", async () => {
    renderWithTrpc(<PlayerActivityView uuid={SMP} />, admin);
    expect(await screen.findByText("Player activity")).toBeTruthy();
    const timeline = await screen.findByTestId("activity-timeline");
    await waitFor(() => expect(within(timeline).getAllByTestId("activity-row").length).toBeGreaterThan(0));
    // balken hebben een toegankelijk label met tijden
    expect(within(timeline).getAllByRole("img")[0]!.getAttribute("aria-label")).toMatch(/: .+ – .+\(/);
    // servergebeurtenissen in de week zijn zichtbaar (mock: elke dag wake/sleep)
    fireEvent.click(within(screen.getByTestId("activity-range")).getByText("Week"));
    await waitFor(() => expect(timeline.querySelectorAll("[data-kind]").length).toBeGreaterThan(3));
    expect(within(screen.getByTestId("activity-legend")).getByText("Sleep")).toBeTruthy();
    // heatmap: 7 rijen × 24 cellen
    const heat = await screen.findByTestId("activity-heatmap");
    await waitFor(() => expect(heat.querySelectorAll("td").length).toBe(7 * 24));
    expect([...heat.querySelectorAll("td")].some((td) => Number(td.getAttribute("data-value")) > 0)).toBe(true);
    // spelerstabel
    const table = await screen.findByTestId("activity-players");
    await waitFor(() => expect(within(table).getAllByTestId("activity-player").length).toBeGreaterThan(2));
    expect(within(table).getByText("Steve")).toBeTruthy();
  });

  it("eerder/later verschuift het venster met end", async () => {
    renderWithTrpc(<PlayerActivityView uuid={SMP} />, admin);
    const card = await screen.findByTestId("activity-timeline");
    const later = screen.getByTestId("activity-later") as HTMLButtonElement;
    expect(later.disabled).toBe(true);
    const period = () => card.querySelector("p")!.textContent!;
    await waitFor(() => expect(period()).toMatch(/ – /));
    const before = period();
    fireEvent.click(screen.getByTestId("activity-earlier"));
    await waitFor(() => expect(period()).not.toBe(before));
    expect(later.disabled).toBe(false);
    fireEvent.click(later);
    await waitFor(() => expect(later.disabled).toBe(true));
  });

  it("niet bijgehouden server: uitleg in plaats van grafieken", async () => {
    renderWithTrpc(<PlayerActivityView uuid={SITE} />, nl);
    expect(await screen.findByTestId("activity-untracked")).toBeTruthy();
    expect(screen.getByText("Niet beschikbaar voor deze server")).toBeTruthy();
    expect(screen.queryByTestId("activity-timeline")).toBeNull();
  });

  it("lege toestand en niemand online", async () => {
    const patch = (m: Implementation) => {
      const pa = m.playerActivity as Mutable<typeof m.playerActivity>;
      pa.current = () => ({ tracked: true, sessions: [] });
      pa.timeline = ({ input }) => ({ tracked: true, range: input.range, from: new Date(Date.now() - 86_400_000), to: new Date(), sessions: [], events: [], truncated: false });
      pa.heatmap = () => ({ tracked: true, days: 28, timezone: "Europe/Amsterdam", cells: Array.from({ length: 7 }, () => Array(24).fill(0) as number[]), max: 0 });
      pa.players = () => ({ tracked: true, days: 30, players: [] });
    };
    renderWithTrpc(<PlayerActivityView uuid={SMP} />, { ...nl, patch });
    expect(await screen.findByText("Er is niemand online.")).toBeTruthy();
    expect(await screen.findByText("Geen spelers in deze periode")).toBeTruthy();
    expect(await screen.findByText("Nog geen gegevens")).toBeTruthy();
    expect(await screen.findByText("Geen spelers in deze periode.")).toBeTruthy();
  });

  it("FORBIDDEN van de server wordt als fout getoond", async () => {
    const patch = (m: Implementation) => {
      (m.playerActivity as Mutable<typeof m.playerActivity>).current = () => {
        throw Object.assign(new Error("FORBIDDEN"), { code: "FORBIDDEN" });
      };
    };
    renderWithTrpc(<PlayerActivityView uuid={SMP} />, { ...admin, patch });
    await waitFor(() => expect(screen.queryByTestId("player-activity")).toBeNull());
  });
});
