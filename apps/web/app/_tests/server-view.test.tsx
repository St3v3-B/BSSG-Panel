// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerDetail } from "@panel/api";
import { classifyLogLine } from "@/app/_components/log-viewer";
import { trpc } from "@/lib/trpc";
import { RenameCard, ReinstallCard, VariablesCard } from "@/app/_components/server/server-settings";
import { ServerView } from "@/app/_components/server/server-view";
import { renderWithTrpc, sessionFor } from "./utils";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/", useParams: () => ({}) }));

beforeAll(() => {
  process.env.NEXT_PUBLIC_PANEL_MOCK = "1";
});
afterEach(cleanup);

const GAME = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
const SITE = "c0ffee00-1234-4abc-8def-0123456789ab";

async function loadServer(uuid: string): Promise<ServerDetail> {
  const { buildRouter } = await import("@panel/api");
  const { createMock } = await import("@panel/api/mock");
  const caller = buildRouter(createMock()).createCaller({ session: sessionFor("admin"), ip: null, userAgent: null, resHeaders: new Headers() } as never);
  return (await caller.servers.get({ uuid })) as ServerDetail;
}

describe("classifyLogLine", () => {
  it("kleurt fouten, waarschuwingen en HTTP 5xx", () => {
    expect(classifyLogLine({ kind: "out", text: '1.2.3.4 - - "POST /x HTTP/1.1" 500 0 "-"' })).toBe("error");
    expect(classifyLogLine({ kind: "out", text: "PHP Fatal error: boem" })).toBe("error");
    expect(classifyLogLine({ kind: "out", text: "php-fpm: [WARNING] pool" })).toBe("warn");
    expect(classifyLogLine({ kind: "out", text: '1.2.3.4 - - "GET / HTTP/1.1" 200 512 "-"' })).toBe("normal");
    expect(classifyLogLine({ kind: "error", text: "x" })).toBe("error");
  });
});

describe("ServerView", () => {
  it("website: logweergave zonder invoerregel, wel powerknoppen en stats", async () => {
    const server = { ...(await loadServer(SITE)), status: "online" as const };
    renderWithTrpc(<ServerView server={server} />, { session: sessionFor("admin") });
    const viewer = await screen.findByTestId("log-viewer");
    expect(screen.queryByLabelText("Commando")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Herstarten|Stoppen/ }).length).toBeGreaterThan(0);
    expect(screen.getByText("CPU")).toBeTruthy();
    // backlog van de mock-socket komt binnen als regels
    await waitFor(() => expect(within(viewer).getByTestId("log-lines").textContent).toMatch(/nginx/), { timeout: 3000 });

    fireEvent.change(screen.getByLabelText("Logs filteren"), { target: { value: "php-fpm" } });
    const lines = within(viewer).getByTestId("log-lines");
    expect(lines.textContent).toMatch(/php-fpm/);
    expect(lines.textContent).not.toMatch(/nginx\/1/);
    fireEvent.click(screen.getByRole("button", { name: "Pauzeren" }));
    expect(screen.getByRole("button", { name: /Volgen/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Weergave wissen" }));
    expect(lines.textContent).toMatch(/Geen regels/);
  });

  it("game-server: console met invoerregel", async () => {
    const server = await loadServer(GAME);
    renderWithTrpc(<ServerView server={server} />, { session: sessionFor("admin") });
    expect(await screen.findByLabelText("Commando")).toBeTruthy();
    expect(screen.queryByTestId("log-viewer")).toBeNull();
  });
});

describe("serverinstellingen", () => {
  it("naam wijzigen roept servers.rename aan", async () => {
    const server = await loadServer(GAME);
    const { bodies } = renderWithTrpc(<RenameCard server={server} />, { session: sessionFor("admin") });
    fireEvent.change(screen.getByLabelText("Servernaam"), { target: { value: "  SMP 2 " } });
    fireEvent.click(screen.getByRole("button", { name: "Opslaan" }));
    await screen.findByText("Naam opgeslagen.");
    expect(bodies.find((b) => b.path === "servers.rename")?.input).toEqual({ uuid: GAME, name: "SMP 2" });
  });

  it("bevestiging blijft zichtbaar nadat servers.get opnieuw laadt met de nieuwe naam", async () => {
    function Harness() {
      const q = trpc.servers.get.useQuery({ uuid: GAME });
      return q.data ? <RenameCard server={q.data} /> : null;
    }
    renderWithTrpc(<Harness />, { session: sessionFor("admin") });
    const input = await screen.findByLabelText("Servernaam");
    fireEvent.change(input, { target: { value: "SMP 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Opslaan" }));
    await screen.findByText("Naam opgeslagen.");
    await waitFor(() => expect((screen.getByLabelText("Servernaam") as HTMLInputElement).value).toBe("SMP 2"));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText("Naam opgeslagen.")).toBeTruthy();
  });

  it("variabelen: patroon wordt gecontroleerd, alleen gewijzigde gaan mee", async () => {
    const base = await loadServer(GAME);
    const server = { ...base, variables: [{ ...base.variables[0]!, pattern: "^(latest|\\d+\\.\\d+(\\.\\d+)?)$" }] };
    const { bodies } = renderWithTrpc(<VariablesCard server={server} />, { session: sessionFor("admin") });
    const input = screen.getByLabelText("Minecraft version");
    fireEvent.change(input, { target: { value: "nieuw" } });
    expect(screen.getByText(/patroon/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Variabelen opslaan/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "1.21.5" } });
    fireEvent.click(screen.getByRole("button", { name: /Variabelen opslaan/ }));
    await screen.findByText(/Herstart de server/);
    expect(bodies.find((b) => b.path === "servers.updateVariables")?.input).toEqual({ uuid: GAME, variables: { MINECRAFT_VERSION: "1.21.5" } });
  });

  it("herinstalleren vraagt bevestiging met uitleg en gaat daarna naar Logs", async () => {
    const server = await loadServer(SITE);
    const { bodies } = renderWithTrpc(<ReinstallCard server={server} />, { session: sessionFor("admin") });
    fireEvent.click(screen.getByRole("button", { name: "Herinstalleren" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toMatch(/bestanden blijven staan/);
    expect(dialog.textContent).toMatch(/public\/ leeg/);
    expect(bodies.some((b) => b.path === "servers.reinstall")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: /Ja, herinstalleren/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/servers/${SITE}`));
    expect(bodies.find((b) => b.path === "servers.reinstall")?.input).toEqual({ uuid: SITE });
  });
});
