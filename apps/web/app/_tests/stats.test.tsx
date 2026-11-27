// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Implementation, ServerSummary, StatsHistory } from "@panel/api";
import { buildPath, indexAt, niceBytes, niceCeil, summarize } from "@/app/_components/stats/chart-math";
import { StatsView } from "@/app/_components/stats/stats-view";
import { ServerCard } from "@/app/_components/server-card";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
beforeAll(() => {
  process.env.NEXT_PUBLIC_PANEL_MOCK = "1";
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const SMP = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
const en = { session: sessionFor("admin"), locale: "en" as const };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

describe("chart-math", () => {
  it("mooie bovengrenzen", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(73)).toBe(100);
    expect(niceCeil(180)).toBe(200);
    expect(niceCeil(220)).toBe(250);
    expect(niceBytes(700 * 1024 ** 2)).toBe(1024 ** 3);
    expect(niceBytes(3 * 1024 ** 3)).toBe(4 * 1024 ** 3);
  });

  it("pad wordt onderbroken bij een gat; een losse meting blijft zichtbaar", () => {
    const d = buildPath([1, 2, null, 3, null, null, 4, 5], 10, 800, 100);
    expect(d.match(/M/g)).toHaveLength(3);
    expect(buildPath([null, 5, null], 10, 300, 100)).toMatch(/^M[\d.]+ 50\.00L[\d.]+ 50\.00$/);
    expect(buildPath([null, null], 10, 100, 100)).toBe("");
    expect(buildPath([1, 2], 10, 100, 100, true)).toMatch(/Z$/);
  });

  it("samenvatting en index onder de cursor", () => {
    expect(summarize([null, 10, 30, null], [null, 15, 50, null])).toEqual({ avg: 20, peak: 50, last: 30 });
    expect(summarize([null, null])).toBeNull();
    expect(indexAt(150, 100, 100, 10)).toBe(5);
    expect(indexAt(50, 100, 100, 10)).toBeNull();
    expect(indexAt(200, 100, 100, 10)).toBe(9);
  });
});

describe("tabblad", () => {
  it("Statistieken alleen met console.read", () => {
    const keys = (permissions: Parameters<typeof serverTabs>[0]["permissions"]) => serverTabs({ uuid: SMP, type: "game", isOwner: false, permissions }).map((x) => x.key);
    expect(keys(["console.read"])).toEqual(["console", "stats", "settings"]);
    expect(keys(["files.write"])).not.toContain("stats");
  });
});

describe("StatsView", () => {
  it("vier grafieken met samenvatting, tooltip via het toetsenbord en een tabel", async () => {
    renderWithTrpc(<StatsView uuid={SMP} />, en);
    expect(screen.getByTestId("stats-loading")).toBeTruthy();
    const cards = await screen.findAllByTestId("chart-card");
    expect(cards.map((c) => c.querySelector(".text-sm.font-medium")?.textContent)).toEqual(["CPU", "Memory", "Disk", "Network"]);
    expect(within(cards[0]!).getByText(/^avg .* · peak /)).toBeTruthy();
    expect(within(cards[0]!).getByText(/^limit 200%$/)).toBeTruthy(); // limietlijn van de mock (cpuPct 200)
    const chart = within(cards[0]!).getByTestId("usage-chart");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    // De crosshair is gedeeld: elke grafiek toont een tooltip voor dezelfde stap.
    const tips = await screen.findAllByTestId("chart-tooltip");
    expect(tips).toHaveLength(4);
    expect(tips[0]!.textContent).toMatch(/CPU/);
    fireEvent.keyDown(chart, { key: "Escape" });
    await waitFor(() => expect(screen.queryAllByTestId("chart-tooltip")).toHaveLength(0));
    expect(screen.getByTestId("stats-table").querySelectorAll("tbody tr").length).toBeGreaterThan(100);
    // netwerk: twee reeksen, de tweede gestippeld (niet alleen kleur)
    const net = within(cards[3]!).getByTestId("usage-chart");
    expect(net.querySelector('[data-series="tx"]')!.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(net.querySelector('[data-series="rx"]')!.getAttribute("stroke-dasharray")).toBeNull();
  });

  it("periode kiezen vraagt de nieuwe periode op en onthoudt hem", async () => {
    const { calls } = renderWithTrpc(<StatsView uuid={SMP} />, en);
    await screen.findAllByTestId("chart-card");
    fireEvent.click(within(screen.getByTestId("stats-range")).getByText("7 days"));
    await waitFor(() => expect(calls.some((c) => c.includes("statsHistory"))).toBe(true));
    await waitFor(() => expect(screen.getByText("7 days").getAttribute("aria-pressed")).toBe("true"));
    expect(localStorage.getItem("panel_stats_range")).toBe("7d");
  });

  it("lege staat als er nog geen metingen zijn (Nederlands)", async () => {
    renderWithTrpc(<StatsView uuid={SMP} />, {
      session: sessionFor("admin"),
      locale: "nl",
      patch: (m) => {
        const s = m.servers as Mutable<Implementation["servers"]>;
        const orig = s.statsHistory;
        s.statsHistory = async (o) => {
          const h = (await orig(o)) as StatsHistory;
          return { ...h, points: h.points.map((p) => ({ ...p, cpuPct: null, cpuMaxPct: null, memoryBytes: null, memoryMaxBytes: null, diskBytes: null, rxBytesPerSec: null, txBytesPerSec: null })) };
        };
      },
    });
    expect(await screen.findByTestId("stats-empty")).toBeTruthy();
    expect(screen.getByText("Nog geen gegevens")).toBeTruthy();
  });

  it("fout van de server wordt getoond", async () => {
    renderWithTrpc(<StatsView uuid={SMP} />, {
      ...en,
      patch: (m) => {
        (m.servers as Mutable<Implementation["servers"]>).statsHistory = async () => {
          const { TRPCError } = await import("@trpc/server");
          throw new TRPCError({ code: "FORBIDDEN", message: "MISSING_PERMISSION: console.read" });
        };
      },
    });
    await waitFor(() => expect(screen.queryByTestId("stats-loading")).toBeNull());
    expect(screen.queryAllByTestId("chart-card")).toHaveLength(0);
  });
});

describe("sparkline op de serverkaart", () => {
  it("alleen voor een draaiende server met metingen", async () => {
    const { buildRouter } = await import("@panel/api");
    const { createMock } = await import("@panel/api/mock");
    const caller = buildRouter(createMock()).createCaller({ session: sessionFor("admin"), ip: null, userAgent: null, resHeaders: new Headers() } as never);
    const list = (await caller.servers.list()) as ServerSummary[];
    const smp = list.find((s) => s.uuid === SMP)!;
    const sparks = await caller.servers.statsSparklines({ uuids: [SMP] });
    expect(sparks[SMP]!.cpuPct).toHaveLength(60);
    renderWithTrpc(<ServerCard server={smp} sparkline={sparks[SMP]} />, en);
    expect(screen.getByTestId("card-sparkline").textContent).toContain("CPU, last hour");
    cleanup();
    renderWithTrpc(<ServerCard server={{ ...smp, status: "offline" }} sparkline={sparks[SMP]} />, en);
    expect(screen.queryByTestId("card-sparkline")).toBeNull();
  });
});
