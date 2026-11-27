// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import type { Me } from "@panel/api";
import { AppShell } from "@/app/_components/app-shell";
import { DatabaseManager } from "@/app/_components/databases/database-manager";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SITE = "c0ffee00-1234-4abc-8def-0123456789ab";
const URL_ = "https://panel.test/phpmyadmin/signon.php?token=abc";
const me = { user: { id: 1, discordId: "100000000000000001", name: "Tester", avatarUrl: null }, isAdmin: false } as unknown as Me;

/** Nep-venster dat window.open teruggeeft. */
function fakeWindow() {
  const w = { location: { href: "about:blank" }, opener: {} as unknown, closed: false, close: vi.fn(() => void (w.closed = true)) };
  return w;
}

describe("phpMyAdmin in de zijbalk", () => {
  it("toont het item (EN-tekst, extern) als de gebruiker databases heeft", async () => {
    localStorage.setItem("panel.sidebar.collapsed", "0"); // uitgeklapt zodat het label zichtbaar is
    renderWithTrpc(<AppShell me={me}>x</AppShell>, { session: sessionFor("user"), locale: "en", patch: (m) => (m.databases.phpMyAdminInfo = () => ({ visible: true, hasRemoteDatabases: false })) });
    const btns = await screen.findAllByTestId("nav-phpmyadmin");
    expect(btns[0]!.textContent).toContain("phpMyAdmin");
    expect(btns[0]!.querySelector("svg.lucide-external-link")).toBeTruthy();
    expect(btns[0]!.getAttribute("title")).toBe("Opens in a new tab");
    localStorage.removeItem("panel.sidebar.collapsed");
  });

  it("verbergt het item zonder databases", async () => {
    const { calls } = renderWithTrpc(<AppShell me={me}>x</AppShell>, { session: sessionFor("user"), patch: (m) => (m.databases.phpMyAdminInfo = () => ({ visible: false, hasRemoteDatabases: false })) });
    await waitFor(() => expect(calls.some((c) => c.includes("databases.phpMyAdminInfo"))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("nav-phpmyadmin")).toBeNull();
  });

  it("klik: opent eerst synchroon een leeg tabblad en zet daarna de URL; noopener", async () => {
    const w = fakeWindow();
    const open = vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);
    let mutated = 0;
    renderWithTrpc(<AppShell me={me}>x</AppShell>, {
      session: sessionFor("user"),
      patch: (m) => {
        m.databases.phpMyAdminInfo = () => ({ visible: true, hasRemoteDatabases: false });
        m.databases.phpMyAdminUrl = () => (mutated++, { url: URL_ });
      },
    });
    const btn = (await screen.findAllByTestId("nav-phpmyadmin"))[0]!;
    fireEvent.click(btn);
    // Synchroon binnen de klik: venster is al geopend, nog zonder URL.
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(w.location.href).toBe("about:blank");
    await waitFor(() => expect(w.location.href).toBe(URL_));
    expect(mutated).toBe(1);
    expect(w.opener).toBeNull();
  });

  it("fout: tabblad dicht en melding getoond", async () => {
    const w = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);
    renderWithTrpc(<AppShell me={me}>x</AppShell>, {
      session: sessionFor("user"),
      locale: "en",
      patch: (m) => {
        m.databases.phpMyAdminInfo = () => ({ visible: true, hasRemoteDatabases: false });
        m.databases.phpMyAdminUrl = () => {
          throw new TRPCError({ code: "FORBIDDEN", message: "NO_DATABASES" });
        };
      },
    });
    fireEvent.click((await screen.findAllByTestId("nav-phpmyadmin"))[0]!);
    await waitFor(() => expect(w.close).toHaveBeenCalled());
    expect((await screen.findAllByRole("alert"))[0]!.textContent).toBe("You don't have any databases yet.");
    expect(w.location.href).toBe("about:blank");
  });

  it("popup geblokkeerd (window.open geeft null): navigeert het huidige tabblad", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const assign = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...orig, assign } });
    try {
      renderWithTrpc(<AppShell me={me}>x</AppShell>, {
        session: sessionFor("user"),
        patch: (m) => {
          m.databases.phpMyAdminInfo = () => ({ visible: true, hasRemoteDatabases: false });
          m.databases.phpMyAdminUrl = () => ({ url: URL_ });
        },
      });
      fireEvent.click((await screen.findAllByTestId("nav-phpmyadmin"))[0]!);
      await waitFor(() => expect(assign).toHaveBeenCalledWith(URL_));
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: orig });
    }
  });
});

describe("Open in phpMyAdmin op het databasescherm", () => {
  it("knop met uitleg; opent via dezelfde flow", async () => {
    const w = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);
    renderWithTrpc(<DatabaseManager uuid={SITE} />, { session: sessionFor("user"), locale: "en", patch: (m) => (m.databases.phpMyAdminUrl = () => ({ url: URL_ })) });
    const btn = await screen.findByTestId("open-phpmyadmin");
    expect(btn.textContent).toContain("Open in phpMyAdmin");
    fireEvent.click(btn);
    await waitFor(() => expect(w.location.href).toBe(URL_));
  });

  it("meldt dat databases op andere nodes er niet in staan", async () => {
    renderWithTrpc(<DatabaseManager uuid={SITE} />, { session: sessionFor("user"), locale: "en", patch: (m) => (m.databases.phpMyAdminInfo = () => ({ visible: true, hasRemoteDatabases: true })) });
    await screen.findByTestId("open-phpmyadmin");
    expect(screen.getByTestId("phpmyadmin-card").textContent).toContain("other nodes");
  });

  it("geen knop als phpMyAdmin uit staat", async () => {
    renderWithTrpc(<DatabaseManager uuid={SITE} />, { session: sessionFor("user"), patch: (m) => (m.databases.phpMyAdminInfo = () => ({ visible: false, hasRemoteDatabases: false })) });
    await screen.findAllByTestId("database-card");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("open-phpmyadmin")).toBeNull();
  });
});
