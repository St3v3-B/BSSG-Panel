// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { UpdatesAdmin } from "@/app/_components/updates";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
beforeAll(() => {
  process.env.NEXT_PUBLIC_PANEL_MOCK = "1";
});
afterEach(cleanup);

const en = { session: sessionFor("admin"), locale: "en" as const };
const nl = { session: sessionFor("admin"), locale: "nl" as const };
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

describe("Updates-pagina", () => {
  it("toont versie, beschikbare commits met CI-status", async () => {
    renderWithTrpc(<UpdatesAdmin />, en);
    expect(await screen.findByText("ui: Updates-pagina")).toBeTruthy();
    const list = screen.getByTestId("available-updates");
    expect(within(list).getByText("CI passed")).toBeTruthy();
    expect(within(list).getByText("CI running")).toBeTruthy();
    expect(screen.getByText(/Commit 15efeda0/)).toBeTruthy();
    expect(screen.getByText("2 new commits on origin/main")).toBeTruthy();
  });

  it("Update panel vraagt bevestiging en start met onlyIfCiGreen (standaard aan)", async () => {
    const { bodies } = renderWithTrpc(<UpdatesAdmin />, en);
    const btn = await screen.findByRole("button", { name: /Update panel/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    expect(await screen.findByText("Update the panel?")).toBeTruthy();
    expect(inputs(bodies, "admin.updates.start")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(inputs(bodies, "admin.updates.start")[0]).toEqual({ onlyIfCiGreen: true }));
  });

  it("CI-vinkje uit wordt meegestuurd", async () => {
    const { bodies } = renderWithTrpc(<UpdatesAdmin />, en);
    const box = await screen.findByLabelText("Only update if CI is green");
    fireEvent.click(box);
    const btn = screen.getByRole("button", { name: /Update panel/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    await waitFor(() => expect(inputs(bodies, "admin.updates.start")[0]).toEqual({ onlyIfCiGreen: false }));
  });

  it("schakelaar roept setEnabled aan", async () => {
    const { bodies } = renderWithTrpc(<UpdatesAdmin />, en);
    fireEvent.click(await screen.findByLabelText("Allow panel updates"));
    await waitFor(() => expect(inputs(bodies, "admin.updates.setEnabled")[0]).toEqual({ enabled: false }));
  });

  it("Nederlandse teksten", async () => {
    renderWithTrpc(<UpdatesAdmin />, nl);
    expect(await screen.findByText("Beschikbare updates")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Panel bijwerken/ })).toBeTruthy();
    expect(screen.getByText("CI geslaagd")).toBeTruthy();
  });
});
