// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { UpdatesAdmin } from "@/app/_components/updates";
import type { Implementation, UpdatesStatus } from "@panel/api";
import { renderWithTrpc, sessionFor } from "./utils";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
/** Vervangt admin.updates.status door de mockstatus met `over` erin. */
const withStatus = (over: Partial<UpdatesStatus>) => (m: Implementation) => {
  const u = m.admin.updates as Mutable<typeof m.admin.updates>;
  const orig = u.status;
  u.status = async (opts) => ({ ...(await (orig as (o: typeof opts) => Promise<UpdatesStatus> | UpdatesStatus)(opts)), ...over });
};

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

  it("toont huidige versie, nieuwe versie ernaast, aantal achter en laatste controle", async () => {
    const checkedAt = new Date(Date.now() - 5 * 60_000);
    renderWithTrpc(<UpdatesAdmin />, { ...en, patch: withStatus({ currentVersion: "0.1.504", latestVersion: "0.1.577", behind: 73, upToDate: false, checkedAt }) });
    expect((await screen.findByTestId("current-version")).textContent).toBe("0.1.504");
    expect(screen.getByTestId("latest-version").textContent).toBe("0.1.577");
    expect(within(screen.getByTestId("update-status")).getByText("73 updates behind")).toBeTruthy();
    expect(screen.getByTestId("last-checked").textContent).toMatch(/5 min ago/);
    // De lijst is begrensd: de telling komt uit `behind`, niet uit de lengte van de lijst.
    expect(screen.getByText(/73 new commits on origin\/main/)).toBeTruthy();
    expect(screen.getByText(/Showing the newest 2 of 73/)).toBeTruthy();
  });

  it("up-to-date: geen nieuwe versie ernaast en knop uit", async () => {
    renderWithTrpc(<UpdatesAdmin />, { ...en, patch: withStatus({ currentVersion: "0.1.504", latestVersion: "0.1.504", behind: 0, upToDate: true, available: [] }) });
    expect(await screen.findByText("Up to date")).toBeTruthy();
    expect(screen.queryByTestId("latest-version")).toBeNull();
    expect(screen.getByText("No newer version")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Update panel/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("onbekend: nog nooit gecontroleerd", async () => {
    renderWithTrpc(<UpdatesAdmin />, { ...nl, patch: withStatus({ currentVersion: null, latestVersion: null, behind: null, upToDate: null, checkedAt: null }) });
    expect(await screen.findByText("Onbekend")).toBeTruthy();
    expect(screen.getByTestId("last-checked").textContent).toBe("Nog nooit");
    expect(screen.getByTestId("current-version").textContent).toBe("–");
  });

  it("bevestiging noemt de versies", async () => {
    renderWithTrpc(<UpdatesAdmin />, nl);
    const btn = await screen.findByRole("button", { name: /Panel bijwerken/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    expect(await screen.findByText(/0\.1\.504 → 0\.1\.506/)).toBeTruthy();
    expect(screen.getByText(/2 updates achter/)).toBeTruthy();
  });
});
