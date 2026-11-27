// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import type { Implementation, Me } from "@panel/api";
import { AppShell } from "@/app/_components/app-shell";
import { DatabaseManager } from "@/app/_components/databases/database-manager";
import DatabasesPage from "@/app/(panel)/databases/page";
import { renderWithTrpc, sessionFor } from "./utils";

const nav = vi.hoisted(() => ({ path: "/", search: "", push: (_: string) => {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (u: string) => nav.push(u) }),
  usePathname: () => nav.path,
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

afterEach(() => {
  cleanup();
  nav.path = "/";
  nav.search = "";
  nav.push = () => {};
  vi.restoreAllMocks();
});

const SITE = "c0ffee00-1234-4abc-8def-0123456789ab";
const URL_ = "/phpmyadmin/signon.php?token=abc";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const writable = (m: Implementation) => m.databases as Mutable<Implementation["databases"]>;
const me = { user: { id: 1, discordId: "100000000000000001", name: "Tester", avatarUrl: null }, isAdmin: false } as unknown as Me;

/** Nep-venster dat window.open teruggeeft. */
function fakeWindow() {
  const w = { location: { href: "about:blank" }, opener: {} as unknown, closed: false, close: vi.fn(() => void (w.closed = true)) };
  return w;
}

const visible = (m: Implementation) => (writable(m).phpMyAdminInfo = () => ({ visible: true, hasRemoteDatabases: false, hostIds: [1] }));

describe("phpMyAdmin in de zijbalk", () => {
  it("is een gewone panelpagina (/databases), actief op die pagina", async () => {
    localStorage.setItem("panel.sidebar.collapsed", "0"); // uitgeklapt zodat het label zichtbaar is
    nav.path = "/databases";
    renderWithTrpc(<AppShell me={me}>x</AppShell>, { session: sessionFor("user"), locale: "en", patch: visible });
    const links = await screen.findAllByRole("link", { name: "phpMyAdmin" });
    expect(links[0]!.getAttribute("href")).toBe("/databases");
    expect(links[0]!.getAttribute("aria-current")).toBe("page");
    expect(links[0]!.querySelector("svg.lucide-external-link")).toBeNull();
    localStorage.removeItem("panel.sidebar.collapsed");
  });

  it("verbergt het item zonder databases", async () => {
    localStorage.setItem("panel.sidebar.collapsed", "0");
    const { calls } = renderWithTrpc(<AppShell me={me}>x</AppShell>, { session: sessionFor("user"), patch: (m) => (writable(m).phpMyAdminInfo = () => ({ visible: false, hasRemoteDatabases: false, hostIds: [] })) });
    await waitFor(() => expect(calls.some((c) => c.includes("databases.phpMyAdminInfo"))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("link", { name: "phpMyAdmin" })).toBeNull();
    localStorage.removeItem("panel.sidebar.collapsed");
  });

  it("op /databases vult de inhoud het hele vlak (geen max-breedte)", async () => {
    nav.path = "/databases";
    renderWithTrpc(<AppShell me={me}>x</AppShell>, { session: sessionFor("user"), patch: visible });
    const main = (await screen.findByText("x")).closest("main")!;
    expect(main.className).not.toContain("max-w-7xl");
    expect(main.className).toContain("min-h-0");
  });
});

describe("ingebedde phpMyAdmin (/databases)", () => {
  it("logt één keer in en zet de sign-on-URL in de iframe", async () => {
    let n = 0;
    renderWithTrpc(<DatabasesPage />, { session: sessionFor("user"), locale: "en", patch: (m) => (visible(m), (writable(m).phpMyAdminUrl = () => ({ url: `${URL_}${++n}` }))) });
    const frame = await screen.findByTestId("phpmyadmin-frame");
    expect(frame.getAttribute("src")).toBe(`${URL_}1`);
    expect(frame.getAttribute("title")).toBe("phpMyAdmin");
    expect(screen.getByText("Signing in to phpMyAdmin…")).toBeTruthy();
    fireEvent.load(frame);
    await waitFor(() => expect(screen.queryByText("Signing in to phpMyAdmin…")).toBeNull());
    await new Promise((r) => setTimeout(r, 30));
    expect(n).toBe(1);
  });

  it("?db= springt direct naar die database; ongeldige namen worden genegeerd", async () => {
    nav.search = "db=s1_wordpress";
    renderWithTrpc(<DatabasesPage />, { session: sessionFor("user"), patch: (m) => (writable(m).phpMyAdminUrl = () => ({ url: URL_ })) });
    expect((await screen.findByTestId("phpmyadmin-frame")).getAttribute("src")).toBe(`${URL_}&db=s1_wordpress`);
    cleanup();
    nav.search = "db=x%26route%3D%2Fserver";
    renderWithTrpc(<DatabasesPage />, { session: sessionFor("user"), patch: (m) => (writable(m).phpMyAdminUrl = () => ({ url: URL_ })) });
    expect((await screen.findByTestId("phpmyadmin-frame")).getAttribute("src")).toBe(URL_);
  });

  it("sessie verlopen (bericht uit de iframe): nieuw token; berichten van elders genegeerd", async () => {
    let n = 0;
    renderWithTrpc(<DatabasesPage />, { session: sessionFor("user"), patch: (m) => (writable(m).phpMyAdminUrl = () => ({ url: `${URL_}${++n}` })) });
    const frame = (await screen.findByTestId("phpmyadmin-frame")) as HTMLIFrameElement;
    const msg = { source: "panel-pma", action: "reauth" };
    window.dispatchEvent(new MessageEvent("message", { data: msg, origin: window.location.origin, source: window }));
    window.dispatchEvent(new MessageEvent("message", { data: msg, origin: "https://evil.test", source: frame.contentWindow }));
    await new Promise((r) => setTimeout(r, 30));
    expect(n).toBe(1);
    window.dispatchEvent(new MessageEvent("message", { data: msg, origin: window.location.origin, source: frame.contentWindow }));
    await waitFor(() => expect(screen.getByTestId("phpmyadmin-frame").getAttribute("src")).toBe(`${URL_}2`));
  });

  it("uitloggen in phpMyAdmin: terug naar het overzicht", async () => {
    const push = vi.fn();
    nav.push = push;
    renderWithTrpc(<DatabasesPage />, { session: sessionFor("user"), patch: (m) => (writable(m).phpMyAdminUrl = () => ({ url: URL_ })) });
    const frame = (await screen.findByTestId("phpmyadmin-frame")) as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", { data: { source: "panel-pma", action: "logout" }, origin: window.location.origin, source: frame.contentWindow }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
  });

  it("geen databases: duidelijke melding in plaats van een lege iframe", async () => {
    renderWithTrpc(<DatabasesPage />, {
      session: sessionFor("user"),
      locale: "en",
      patch: (m) => {
        writable(m).phpMyAdminUrl = () => {
          throw new TRPCError({ code: "FORBIDDEN", message: "NO_DATABASES" });
        };
      },
    });
    expect((await screen.findByRole("alert")).textContent).toBe("You don't have any databases yet.");
    expect(screen.queryByTestId("phpmyadmin-frame")).toBeNull();
  });

  it("los tabblad: opent synchroon een leeg tabblad, zet daarna de absolute URL; noopener", async () => {
    const w = fakeWindow();
    const open = vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);
    renderWithTrpc(<DatabasesPage />, { session: sessionFor("user"), patch: (m) => (writable(m).phpMyAdminUrl = () => ({ url: URL_ })) });
    await screen.findByTestId("phpmyadmin-frame");
    fireEvent.click(screen.getByTestId("phpmyadmin-newtab"));
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    await waitFor(() => expect(w.location.href).toBe(new URL(URL_, window.location.origin).toString()));
    expect(w.opener).toBeNull();
  });

  it("los tabblad geblokkeerd: navigeert het huidige tabblad", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const assign = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...orig, origin: orig.origin, assign } });
    try {
      renderWithTrpc(<DatabasesPage />, { session: sessionFor("user"), patch: (m) => (writable(m).phpMyAdminUrl = () => ({ url: URL_ })) });
      await screen.findByTestId("phpmyadmin-frame");
      fireEvent.click(screen.getByTestId("phpmyadmin-newtab"));
      await waitFor(() => expect(assign).toHaveBeenCalledWith(new URL(URL_, orig.origin).toString()));
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: orig });
    }
  });
});

describe("Open in phpMyAdmin op het databasescherm", () => {
  it("kaart linkt naar de ingebedde phpMyAdmin, elke database direct", async () => {
    renderWithTrpc(<DatabaseManager uuid={SITE} />, { session: sessionFor("user"), locale: "en", patch: visible });
    const btn = await screen.findByTestId("open-phpmyadmin");
    expect(btn.textContent).toContain("Open in phpMyAdmin");
    expect(btn.getAttribute("href")).toBe("/databases");
    const per = await screen.findAllByTestId("open-db-phpmyadmin");
    expect(per[0]!.getAttribute("href")).toMatch(/^\/databases\?db=s\d+_\w+$/);
  });

  it("meldt dat databases op een externe host er niet in staan; die krijgen geen eigen knop", async () => {
    renderWithTrpc(<DatabaseManager uuid={SITE} />, { session: sessionFor("user"), locale: "en", patch: (m) => (writable(m).phpMyAdminInfo = () => ({ visible: true, hasRemoteDatabases: true, hostIds: [7] })) });
    await screen.findByTestId("open-phpmyadmin");
    expect(screen.getByTestId("phpmyadmin-card").textContent).toContain("external database host");
    await screen.findAllByTestId("database-card");
    expect(screen.queryByTestId("open-db-phpmyadmin")).toBeNull();
  });

  it("databases op remote nodes staan er gewoon in: geen melding, wel de knop per database", async () => {
    renderWithTrpc(<DatabaseManager uuid={SITE} />, { session: sessionFor("user"), locale: "en", patch: (m) => (writable(m).phpMyAdminInfo = () => ({ visible: true, hasRemoteDatabases: false, hostIds: [1, 7] })) });
    await screen.findAllByTestId("open-db-phpmyadmin");
    expect(screen.getByTestId("phpmyadmin-card").textContent).not.toContain("external");
  });

  it("geen knoppen als phpMyAdmin uit staat", async () => {
    renderWithTrpc(<DatabaseManager uuid={SITE} />, { session: sessionFor("user"), patch: (m) => (writable(m).phpMyAdminInfo = () => ({ visible: false, hasRemoteDatabases: false, hostIds: [] })) });
    await screen.findAllByTestId("database-card");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("open-phpmyadmin")).toBeNull();
    expect(screen.queryByTestId("open-db-phpmyadmin")).toBeNull();
  });
});
