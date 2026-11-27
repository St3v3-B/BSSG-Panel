// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerDetail } from "@panel/api";
import { ImageUpdateCard, ImageUpdateNotice, ImageUpdatesAdmin } from "@/app/_components/image-updates";
import { ServerCard } from "@/app/_components/server-card";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
beforeAll(() => {
  process.env.NEXT_PUBLIC_PANEL_MOCK = "1";
});
afterEach(cleanup);

const GAME = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
const SITE = "c0ffee00-1234-4abc-8def-0123456789ab";
const en = { session: sessionFor("admin"), locale: "en" as const };
const nl = { session: sessionFor("admin"), locale: "nl" as const };
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

async function loadServer(uuid: string): Promise<ServerDetail> {
  const { buildRouter } = await import("@panel/api");
  const { createMock } = await import("@panel/api/mock");
  const caller = buildRouter(createMock()).createCaller({ session: sessionFor("admin"), ip: null, userAgent: null, resHeaders: new Headers() } as never);
  return (await caller.servers.get({ uuid })) as ServerDetail;
}

describe("image-updates UI", () => {
  it("badge op de serverkaart, in het Nederlands vertaald", async () => {
    renderWithTrpc(<ServerCard server={await loadServer(GAME)} />, en);
    expect(screen.getByTestId("image-update-badge").textContent).toMatch(/Image update available/);
    cleanup();
    renderWithTrpc(<ServerCard server={await loadServer(GAME)} />, nl);
    expect(screen.getByTestId("image-update-badge").textContent).toMatch(/Image-update beschikbaar/);
  });

  it("melding met Nu bijwerken roept servers.updateImageNow aan", async () => {
    const { bodies } = renderWithTrpc(<ImageUpdateNotice server={await loadServer(GAME)} canManage />, en);
    fireEvent.click(screen.getByRole("button", { name: /Update now/ }));
    await waitFor(() => expect(inputs(bodies, "servers.updateImageNow")[0]).toEqual({ uuid: GAME }));
    expect(await screen.findByText(/Update started/)).toBeTruthy();
  });

  it("zonder beheerrechten geen knop; reinstall nodig → geen knop en uitleg", async () => {
    renderWithTrpc(<ImageUpdateNotice server={await loadServer(GAME)} canManage={false} />, en);
    expect(screen.queryByRole("button", { name: /Update now/ })).toBeNull();
    cleanup();
    renderWithTrpc(<ImageUpdateNotice server={await loadServer(SITE)} canManage />, en);
    expect(screen.getByTestId("image-update-notice").textContent).toMatch(/different PHP version/);
    expect(screen.queryByRole("button", { name: /Update now/ })).toBeNull();
  });

  it("beleid kiezen en opslaan", async () => {
    const { bodies } = renderWithTrpc(<ImageUpdateCard server={await loadServer(GAME)} />, en);
    const select = screen.getByLabelText("Policy") as HTMLSelectElement;
    expect(select.value).toBe("default");
    fireEvent.change(select, { target: { value: "auto" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Image update settings saved.")).toBeTruthy();
    expect(inputs(bodies, "servers.updateImagePolicy")[0]).toEqual({ uuid: GAME, policy: "auto" });
    fireEvent.change(select, { target: { value: "default" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(inputs(bodies, "servers.updateImagePolicy")[1]).toEqual({ uuid: GAME, policy: null }));
  });

  it("adminpagina: overzicht, venster opslaan en nu controleren", async () => {
    const { bodies } = renderWithTrpc(<ImageUpdatesAdmin />, en);
    const rows = await screen.findAllByTestId("image-row");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(within(rows[0]!).getByTestId("image-update-badge")).toBeTruthy();
    expect(screen.getByText(/servers have an update available/)).toBeTruthy();
    const start = (await screen.findByLabelText("Maintenance window from")) as HTMLInputElement;
    expect(start.value).toBe("04:00");
    fireEvent.change(start, { target: { value: "03:00" } });
    fireEvent.change(screen.getByLabelText("Default policy"), { target: { value: "auto" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Image update settings saved.")).toBeTruthy();
    expect(inputs(bodies, "admin.settings.update")[0]).toEqual({ imageUpdates: { defaultPolicy: "auto", windowStart: "03:00", windowEnd: "05:00" } });
    fireEvent.click(screen.getByRole("button", { name: /Check now/ }));
    await waitFor(() => expect(inputs(bodies, "admin.imageUpdates.checkNow").length).toBe(1));
  });
});
