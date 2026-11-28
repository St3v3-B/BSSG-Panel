// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { TRPCError } from "@trpc/server";
import type { ReactNode } from "react";
import type { Implementation } from "@panel/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserDetail } from "@/app/_components/admin/user-detail";
import { renderWithTrpc, sessionFor } from "./utils";

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
const wa = vi.hoisted(() => ({ supported: true, startRegistration: vi.fn(), startAuthentication: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => wa.supported,
  startRegistration: wa.startRegistration,
  startAuthentication: wa.startAuthentication,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => "/login",
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

const { default: LoginPage } = await import("@/app/login/page");
const { default: AccountPage } = await import("@/app/(panel)/account/page");

afterEach(() => {
  cleanup();
  nav.replace.mockReset();
  wa.startRegistration.mockReset();
  wa.startAuthentication.mockReset();
  wa.supported = true;
});

type W = { auth: Record<string, unknown>; account: Record<string, unknown> };
const w = (m: Implementation) => m as unknown as W;
const input = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);
const meOf = (totpEnabled: boolean, totpVerified: boolean) => ({
  user: { id: 2, discordId: "100000000000000002", name: "blokgenoot", avatarUrl: null },
  isAdmin: false,
  isOwner: false,
  isEmergency: false,
  totpEnabled,
  totpVerified,
});
const fakeResponse = { id: "cred1", rawId: "cred1", type: "public-key", response: { clientDataJSON: "e30" }, clientExtensionResults: {} };
const cancelled = () => Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });

describe("login: passkey", () => {
  it("knop alleen als de browser WebAuthn ondersteunt", async () => {
    wa.supported = false;
    renderWithTrpc(<LoginPage />, { session: null });
    expect(await screen.findByTestId("discord-login")).toBeTruthy();
    expect(screen.queryByTestId("passkey-login")).toBeNull();
  });

  it("inloggen met passkey: opties → browser → login → door", async () => {
    let loggedIn = false;
    wa.startAuthentication.mockResolvedValue(fakeResponse);
    const { bodies } = renderWithTrpc(<LoginPage />, {
      session: null,
      patch: (m) => {
        w(m).auth.me = () => (loggedIn ? meOf(true, true) : null);
        w(m).auth.passkeyLogin = () => ((loggedIn = true), { ok: true });
      },
    });
    const btn = await screen.findByTestId("passkey-login");
    expect(btn.textContent).toContain("Inloggen met passkey");
    fireEvent.click(btn);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/"));
    expect(wa.startAuthentication).toHaveBeenCalledWith({ optionsJSON: expect.objectContaining({ challenge: expect.any(String) }) });
    expect(input(bodies, "auth.passkeyLogin")[0]).toEqual({ response: fakeResponse });
  });

  it("afbreken toont geen fout; een serverfout wel", async () => {
    wa.startAuthentication.mockRejectedValueOnce(cancelled()).mockResolvedValueOnce(fakeResponse);
    renderWithTrpc(<LoginPage />, {
      session: null,
      patch: (m) => {
        w(m).auth.passkeyLogin = () => {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "INVALID_PASSKEY" });
        };
      },
    });
    fireEvent.click(await screen.findByTestId("passkey-login"));
    await waitFor(() => expect(wa.startAuthentication).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByTestId("passkey-login") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("passkey-login-error")).toBeNull();
    fireEvent.click(screen.getByTestId("passkey-login"));
    expect((await screen.findByTestId("passkey-login-error")).textContent).toBe("Die passkey kon niet worden gecontroleerd. Probeer het opnieuw.");
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("TOTP-stap: 'Passkey gebruiken' verifieert de sessie", async () => {
    let verified = false;
    wa.startAuthentication.mockResolvedValue(fakeResponse);
    const { bodies } = renderWithTrpc(<LoginPage />, {
      session: sessionFor("pending"),
      patch: (m) => {
        w(m).auth.me = () => meOf(true, verified);
        w(m).auth.passkeyVerifyOptions = () => ({ challenge: "abc", allowCredentials: [{ id: "cred1", type: "public-key" }] });
        w(m).auth.passkeyVerify = () => ((verified = true), { ok: true });
      },
    });
    expect(await screen.findByTestId("totp-step")).toBeTruthy();
    fireEvent.click(screen.getByTestId("passkey-verify"));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/"));
    expect(wa.startAuthentication).toHaveBeenCalledWith({ optionsJSON: expect.objectContaining({ challenge: "abc" }) });
    expect(input(bodies, "auth.passkeyVerify")[0]).toEqual({ response: fakeResponse });
  });

  it("TOTP-stap zonder passkeys toont de melding", async () => {
    renderWithTrpc(<LoginPage />, {
      session: sessionFor("pending"),
      patch: (m) => {
        w(m).auth.me = () => meOf(true, false);
        w(m).auth.passkeyVerifyOptions = () => {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_PASSKEYS" });
        };
      },
    });
    fireEvent.click(await screen.findByTestId("passkey-verify"));
    expect((await screen.findByTestId("passkey-verify-error")).textContent).toBe("Je hebt geen passkeys. Gebruik je code.");
    expect(wa.startAuthentication).not.toHaveBeenCalled();
  });
});

describe("account: passkeys", () => {
  it("toevoegen, hernoemen en verwijderen met bevestiging", async () => {
    wa.startRegistration.mockResolvedValue(fakeResponse);
    const { bodies } = renderWithTrpc(<AccountPage />, { session: sessionFor("user"), patch: (m) => void (w(m).account.get = () => meOf(false, false)) });
    const card = await screen.findByTestId("passkeys-card");
    expect(await within(card).findByText("Je hebt nog geen passkeys.")).toBeTruthy();
    fireEvent.click(within(card).getByTestId("passkey-add"));
    fireEvent.change(within(card).getByLabelText("Naam"), { target: { value: "Telefoon" } });
    fireEvent.click(within(card).getByTestId("passkey-create"));
    expect(await within(card).findByTestId("passkey-added")).toBeTruthy();
    expect(input(bodies, "account.passkeys.register")[0]).toEqual({ name: "Telefoon", response: fakeResponse });
    expect(wa.startRegistration).toHaveBeenCalledWith({ optionsJSON: expect.objectContaining({ challenge: expect.any(String) }) });
    const list = await within(card).findByTestId("passkey-list");
    expect(list.textContent).toContain("Telefoon");
    expect(list.textContent).toContain("nooit gebruikt");

    const id = Number(list.querySelector("li")!.getAttribute("data-testid")!.replace("passkey-", ""));
    fireEvent.click(within(card).getByTestId(`passkey-rename-${id}`));
    const name = within(list).getByLabelText("Naam");
    fireEvent.change(name, { target: { value: "Werktelefoon" } });
    fireEvent.click(within(card).getByTestId(`passkey-rename-save-${id}`));
    await waitFor(() => expect(within(card).getByTestId("passkey-list").textContent).toContain("Werktelefoon"));

    fireEvent.click(within(card).getByTestId(`passkey-delete-${id}`));
    expect(within(card).getByText(/“Werktelefoon” verwijderen\?/)).toBeTruthy();
    fireEvent.click(within(card).getByTestId(`passkey-delete-confirm-${id}`));
    expect(await within(card).findByText("Je hebt nog geen passkeys.")).toBeTruthy();
    expect(input(bodies, "account.passkeys.delete")[0]).toEqual({ id });
  });

  it("afbreken in de browser voegt niets toe", async () => {
    wa.startRegistration.mockRejectedValue(cancelled());
    const { bodies } = renderWithTrpc(<AccountPage />, { session: sessionFor("user"), patch: (m) => void (w(m).account.get = () => meOf(false, false)) });
    const card = await screen.findByTestId("passkeys-card");
    fireEvent.click(await within(card).findByTestId("passkey-add"));
    fireEvent.click(within(card).getByTestId("passkey-create"));
    expect(await within(card).findByText("Afgebroken. Er is geen passkey toegevoegd.")).toBeTruthy();
    expect(input(bodies, "account.passkeys.register")).toEqual([]);
  });

  it("zonder WebAuthn-ondersteuning geen toevoegknop; geen kaart voor het noodaccount", async () => {
    wa.supported = false;
    renderWithTrpc(<AccountPage />, { session: sessionFor("user"), patch: (m) => void (w(m).account.get = () => meOf(false, false)) });
    expect(await screen.findByTestId("passkey-unsupported")).toBeTruthy();
    expect(screen.queryByTestId("passkey-add")).toBeNull();
    cleanup();
    renderWithTrpc(<AccountPage />, { session: sessionFor("user"), patch: (m) => void (w(m).account.get = () => ({ ...meOf(true, true), isEmergency: true })) });
    expect(await screen.findByTestId("totp-card")).toBeTruthy();
    expect(screen.queryByTestId("passkeys-card")).toBeNull();
  });
});

describe("admin: passkeys van een gebruiker", () => {
  it("toont het aantal en verwijdert alles na bevestiging", async () => {
    const { bodies } = renderWithTrpc(<UserDetail id={1} />, { session: sessionFor("admin") });
    const sec = await screen.findByTestId("user-passkeys");
    expect((await within(sec).findByTestId("user-passkey-count")).textContent).toBe("1 passkey");
    expect(sec.textContent).toContain("MacBook Touch ID");
    fireEvent.click(within(sec).getByTestId("user-passkeys-delete"));
    fireEvent.click(within(sec).getByTestId("user-passkeys-delete-confirm"));
    expect((await within(sec).findByTestId("user-passkeys-deleted")).textContent).toBe("1 passkey verwijderd.");
    await waitFor(() => expect(within(sec).getByTestId("user-passkey-count").textContent).toBe("0 passkeys"));
    expect(input(bodies, "admin.users.deletePasskeys")[0]).toEqual({ id: 1 });
  });
});
