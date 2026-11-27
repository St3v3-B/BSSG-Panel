// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerDetail } from "@panel/api";
import { ServerCard } from "@/app/_components/server-card";
import { StatusBadge } from "@/app/_components/status-badge";
import { applyOptimisticPower } from "@/app/_lib/optimistic-power";
import { trpc } from "@/lib/trpc";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
beforeAll(() => {
  process.env.NEXT_PUBLIC_PANEL_MOCK = "1";
});
afterEach(cleanup);

const GAME = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
const en = { session: sessionFor("admin"), locale: "en" as const };

async function loadServer(): Promise<ServerDetail> {
  const { buildRouter } = await import("@panel/api");
  const { createMock } = await import("@panel/api/mock");
  const caller = buildRouter(createMock()).createCaller({ session: sessionFor("admin"), ip: null, userAgent: null, resHeaders: new Headers() } as never);
  return (await caller.servers.get({ uuid: GAME })) as ServerDetail;
}

describe("data laden", () => {
  it("hover op een serverkaart haalt de details alvast op", async () => {
    const { calls } = renderWithTrpc(<ServerCard server={{ ...(await loadServer()), status: "offline" }} />, en);
    expect(calls.some((c) => c.includes("servers.get"))).toBe(false);
    fireEvent.mouseEnter(screen.getByTestId("server-card"));
    await waitFor(() => expect(calls.some((c) => c.includes("servers.get"))).toBe(true));
  });

  it("status unknown: tooltip met laatst gezien", () => {
    renderWithTrpc(<StatusBadge status="unknown" lastSeenAt={new Date("2026-01-02T10:00:00Z")} />, en);
    expect(screen.getByText("Unknown").closest("[data-status]")!.getAttribute("title")).toMatch(/^Last seen /);
    cleanup();
    renderWithTrpc(<StatusBadge status="unknown" lastSeenAt={null} />, en);
    expect(screen.getByText("Unknown").closest("[data-status]")!.getAttribute("title")).toBe("Never reached yet");
  });

  it("optimistische power: status staat meteen in de cache en gaat terug bij een fout", async () => {
    function Probe() {
      const utils = trpc.useUtils();
      const list = trpc.servers.list.useQuery();
      const [done, setDone] = useState("");
      const s = list.data?.find((x) => x.uuid === GAME);
      useEffect(() => {
        if (!s || done) return;
        setDone("busy");
        void (async () => {
          const rollback = await applyOptimisticPower(utils, GAME, "stop");
          setDone(`after:${utils.servers.list.getData()!.find((x) => x.uuid === GAME)!.status}`);
          rollback();
          setDone((d) => `${d}|rolled:${utils.servers.list.getData()!.find((x) => x.uuid === GAME)!.status}`);
        })();
      }, [s, done, utils]);
      return <div data-testid="out">{done}</div>;
    }
    renderWithTrpc(<Probe />, en);
    await waitFor(() => expect(screen.getByTestId("out").textContent).toMatch(/rolled:/));
    expect(screen.getByTestId("out").textContent).toMatch(/^after:stopping\|rolled:(online|offline|starting|sleeping)/);
  });
});
