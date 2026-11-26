// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "@panel/api";
import { decideAdmin, decideGate, loginHref, safeRedirect } from "@/app/_lib/auth-routing";
import { renderWithTrpc, sessionFor } from "./utils";

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), pathname: "/servers/abc" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { AuthGate } = await import("@/app/_components/auth-gate");
const { default: AdminLayout } = await import("@/app/(panel)/admin/layout");

afterEach(() => {
  cleanup();
  nav.replace.mockReset();
});

const me = (p: Partial<Me> = {}): Me => ({
  user: { id: 1, discordId: "100000000000000001", name: "steve", avatarUrl: null },
  isAdmin: false,
  isOwner: false,
  isEmergency: false,
  totpEnabled: false,
  totpVerified: false,
  ...p,
});

describe("decideGate / redirects", () => {
  it("bepaalt per sessie wat de browser toont", () => {
    expect(decideGate({ pathname: "/", me: undefined })).toEqual({ kind: "loading" });
    expect(decideGate({ pathname: "/admin", me: null })).toEqual({ kind: "redirect", to: "/login?redirectTo=%2Fadmin" });
    expect(decideGate({ pathname: "/", me: me({ totpEnabled: true }) })).toEqual({ kind: "redirect", to: "/login" });
    expect(decideGate({ pathname: "/", me: me() })).toEqual({ kind: "ok" });
    expect(decideGate({ pathname: "/", me: me(), accountError: { blocked: true, totpPending: false, unauthorized: false } })).toEqual({ kind: "blocked" });
  });
  it("redirectTo alleen naar interne paden", () => {
    expect(safeRedirect("/servers/x")).toBe("/servers/x");
    for (const bad of ["https://evil.test", "//evil.test", "/\\evil.test", "/login", null, ""]) expect(safeRedirect(bad)).toBe("/");
    expect(loginHref("//evil")).toBe("/login");
  });
  it("admin vereist admin + 2FA aan en geverifieerd", () => {
    expect(decideAdmin(me())).toBe("not_admin");
    expect(decideAdmin(me({ isAdmin: true }))).toBe("totp_required");
    expect(decideAdmin(me({ isAdmin: true, totpEnabled: true, totpVerified: true }))).toBe("ok");
  });
});

describe("AuthGate tegen de mock", () => {
  const child = (m: Me) => <div data-testid="inhoud">{m.user.name}</div>;

  it("anoniem → naar /login met redirectTo", async () => {
    renderWithTrpc(<AuthGate>{child}</AuthGate>, { session: sessionFor("anonymous") });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/login?redirectTo=%2Fservers%2Fabc"));
    expect(screen.queryByTestId("inhoud")).toBeNull();
  });

  it("TOTP nog niet ingevoerd (pending) → naar /login", async () => {
    renderWithTrpc(<AuthGate>{child}</AuthGate>, { session: sessionFor("pending") });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/login?redirectTo=%2Fservers%2Fabc"));
  });

  it("gebruiker → inhoud", async () => {
    renderWithTrpc(<AuthGate>{child}</AuthGate>, { session: sessionFor("user") });
    expect((await screen.findByTestId("inhoud")).textContent).toBe("blokgenoot");
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("geblokkeerd (FORBIDDEN BLOCKED) → geblokkeerd-scherm", async () => {
    renderWithTrpc(<AuthGate>{child}</AuthGate>, { session: sessionFor("user", { blocked: true }) });
    expect(await screen.findByTestId("blocked")).toBeTruthy();
    expect(screen.queryByTestId("inhoud")).toBeNull();
  });
});

describe("Admin-layout", () => {
  it("gebruiker zonder adminrechten krijgt 'Geen toegang'", async () => {
    renderWithTrpc(<AdminLayout>geheim</AdminLayout>, { session: sessionFor("user") });
    expect(await screen.findByTestId("admin-forbidden")).toBeTruthy();
    expect(screen.queryByText("geheim")).toBeNull();
  });
  it("admin zonder 2FA krijgt uitleg met link naar /account", async () => {
    renderWithTrpc(<AdminLayout>geheim</AdminLayout>, { session: sessionFor("admin", { totpEnabled: false, totpVerified: false }) });
    const box = await screen.findByTestId("admin-totp-required");
    expect(box.querySelector('a[href="/account"]')).toBeTruthy();
  });
  it("admin met 2FA ziet de inhoud", async () => {
    renderWithTrpc(<AdminLayout>geheim</AdminLayout>, { session: sessionFor("admin") });
    expect(await screen.findByText("geheim")).toBeTruthy();
  });
});
