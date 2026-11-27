// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerDetail, ServerSummary } from "@panel/api";
import { ServerCard } from "@/app/_components/server-card";
import { SleepCard } from "@/app/_components/server/server-settings";
import { ServerView } from "@/app/_components/server/server-view";
import { StatusBadge } from "@/app/_components/status-badge";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
// xterm draait niet in jsdom
vi.mock("@/app/_components/console-terminal", () => ({ ConsoleTerminal: () => <div data-testid="terminal" /> }));
beforeAll(() => {
  process.env.NEXT_PUBLIC_PANEL_MOCK = "1";
});
afterEach(cleanup);

const GAME = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
const SITE = "c0ffee00-1234-4abc-8def-0123456789ab";
const en = { session: sessionFor("admin"), locale: "en" as const };
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

async function loadServer(uuid: string): Promise<ServerDetail> {
  const { buildRouter } = await import("@panel/api");
  const { createMock } = await import("@panel/api/mock");
  const caller = buildRouter(createMock()).createCaller({ session: sessionFor("admin"), ip: null, userAgent: null, resHeaders: new Headers() } as never);
  return (await caller.servers.get({ uuid })) as ServerDetail;
}

describe("slaapstand", () => {
  it("badge 'Sleeping' / 'Slaapt'", () => {
    renderWithTrpc(<StatusBadge status="sleeping" />, en);
    expect(screen.getByText("Sleeping")).toBeTruthy();
    cleanup();
    renderWithTrpc(<StatusBadge status="sleeping" />, { session: null });
    expect(screen.getByText("Slaapt")).toBeTruthy();
  });

  it("instellingen: minuten controleren en opslaan", async () => {
    const { bodies } = renderWithTrpc(<SleepCard server={await loadServer(GAME)} />, en);
    const card = screen.getByTestId("sleep-card");
    expect(card.textContent).toMatch(/nobody has been online for 10 minutes/);
    const input = screen.getByLabelText("Minutes without players");
    fireEvent.change(input, { target: { value: "0" } });
    expect(screen.getByText("Between 1 and 1440 minutes")).toBeTruthy();
    fireEvent.change(input, { target: { value: "30" } });
    expect(card.textContent).toMatch(/for 30 minutes/);
    fireEvent.click(screen.getByRole("button", { name: /Save sleep mode/ }));
    expect(await screen.findByText("Sleep mode saved.")).toBeTruthy();
    expect(inputs(bodies, "servers.updateSleep")[0]).toEqual({ uuid: GAME, enabled: true, idleMinutes: 30 });
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: /Save sleep mode/ }));
    await waitFor(() => expect(inputs(bodies, "servers.updateSleep")[1]).toEqual({ uuid: GAME, enabled: false, idleMinutes: 30 }));
  });

  it("niet getoond zonder ondersteuning", async () => {
    renderWithTrpc(<SleepCard server={await loadServer(SITE)} />, en);
    expect(screen.queryByTestId("sleep-card")).toBeNull();
  });

  it("serverpagina: uitleg en startknop bij sleeping", async () => {
    const server = { ...(await loadServer(GAME)), status: "sleeping" as const };
    const { bodies } = renderWithTrpc(<ServerView server={server} />, en);
    const notice = await screen.findByTestId("sleeping-notice");
    expect(notice.textContent).toMatch(/The server is sleeping/);
    fireEvent.click(within(notice).getByRole("button", { name: /Start/ }));
    await waitFor(() => expect(inputs(bodies, "servers.power")[0]).toEqual({ uuid: GAME, action: "start" }));
  });

  it("overzicht: hint en startknop", async () => {
    const d = await loadServer(GAME);
    const summary: ServerSummary = { ...d, status: "sleeping" };
    const { bodies } = renderWithTrpc(<ServerCard server={summary} />, en);
    const hint = screen.getByTestId("sleeping-hint");
    expect(hint.textContent).toMatch(/starts when someone connects/);
    fireEvent.click(within(hint).getByRole("button", { name: /Start/ }));
    await waitFor(() => expect(inputs(bodies, "servers.power")[0]).toEqual({ uuid: GAME, action: "start" }));
  });
});
