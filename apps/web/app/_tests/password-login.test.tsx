// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { TRPCError } from "@trpc/server";
import type { ReactNode } from "react";
import type { Implementation } from "@panel/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { suggestUsername, UserDetail } from "@/app/_components/admin/user-detail";
import { renderWithTrpc, sessionFor } from "./utils";

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
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

describe("login: backup-login", () => {
  it("link naar het wachtwoordformulier staat onder Discord, naast de noodlogin", async () => {
    renderWithTrpc(<LoginPage />, { session: null });
    expect(await screen.findByTestId("discord-login")).toBeTruthy();
    expect(screen.getByTestId("password-link").textContent).toBe("Inloggen met gebruikersnaam en wachtwoord");
    expect(screen.getByTestId("emergency-link")).toBeTruthy();
    fireEvent.click(screen.getByTestId("password-link"));
    expect(await screen.findByTestId("password-step")).toBeTruthy();
    expect(screen.queryByTestId("emergency-link")).toBeNull();
    fireEvent.click(screen.getByText("Terug naar inloggen met Discord"));
    expect(await screen.findByTestId("discord-login")).toBeTruthy();
  });

  it("stuurt naam + wachtwoord en gaat door zonder 2FA", async () => {
    let loggedIn = false;
    const { bodies } = renderWithTrpc(<LoginPage />, {
      session: null,
      patch: (m) => {
        w(m).auth.me = () => (loggedIn ? meOf(false, false) : null);
        w(m).auth.passwordLogin = () => ((loggedIn = true), { ok: true });
      },
    });
    fireEvent.click(await screen.findByTestId("password-link"));
    const submit = await screen.findByRole("button", { name: "Inloggen" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Gebruikersnaam"), { target: { value: " Blokgenoot " } });
    fireEvent.change(screen.getByLabelText("Wachtwoord"), { target: { value: "een-lang-wachtwoord" } });
    fireEvent.click(submit);
    await waitFor(() => expect(input(bodies, "auth.passwordLogin")[0]).toEqual({ username: "blokgenoot", password: "een-lang-wachtwoord" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/"));
  });

  it("met 2FA aan volgt de TOTP-stap", async () => {
    let loggedIn = false;
    renderWithTrpc(<LoginPage />, {
      session: null,
      patch: (m) => {
        w(m).auth.me = () => (loggedIn ? meOf(true, false) : null);
        w(m).auth.passwordLogin = () => ((loggedIn = true), { ok: true });
      },
    });
    fireEvent.click(await screen.findByTestId("password-link"));
    fireEvent.change(await screen.findByLabelText("Gebruikersnaam"), { target: { value: "blokgenoot" } });
    fireEvent.change(screen.getByLabelText("Wachtwoord"), { target: { value: "een-lang-wachtwoord" } });
    fireEvent.click(screen.getByRole("button", { name: "Inloggen" }));
    expect(await screen.findByTestId("totp-step")).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("toont duidelijke fouten: verkeerde gegevens en te veel pogingen", async () => {
    let n = 0;
    renderWithTrpc(<LoginPage />, {
      session: null,
      patch: (m) => {
        w(m).auth.passwordLogin = () => {
          n++;
          throw n === 1 ? new TRPCError({ code: "UNAUTHORIZED", message: "INVALID_CREDENTIALS" }) : new TRPCError({ code: "TOO_MANY_REQUESTS", message: "TOO_MANY_ATTEMPTS" });
        };
      },
    });
    fireEvent.click(await screen.findByTestId("password-link"));
    fireEvent.change(await screen.findByLabelText("Gebruikersnaam"), { target: { value: "iemand" } });
    fireEvent.change(screen.getByLabelText("Wachtwoord"), { target: { value: "fout" } });
    fireEvent.click(screen.getByRole("button", { name: "Inloggen" }));
    expect((await screen.findByTestId("password-error")).textContent).toBe("Gebruikersnaam of wachtwoord klopt niet.");
    expect((screen.getByLabelText("Wachtwoord") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Wachtwoord"), { target: { value: "nog-eens" } });
    fireEvent.click(screen.getByRole("button", { name: "Inloggen" }));
    await waitFor(() => expect(screen.getByTestId("password-error").textContent).toContain("Te veel mislukte pogingen"));
    expect(nav.replace).not.toHaveBeenCalled();
  });
});

describe("account: backup-login", () => {
  it("aanzetten zonder 2FA, met controle op wachtwoord, daarna uitzetten met bevestiging", async () => {
    const { bodies } = renderWithTrpc(<AccountPage />, { session: sessionFor("user"), patch: (m) => void (w(m).account.get = () => meOf(false, false)) });
    const card = await screen.findByTestId("password-login-card");
    await waitFor(() => expect(card.textContent).toContain("Uit"));
    fireEvent.click(await screen.findByTestId("password-login-edit"));
    expect(screen.queryByLabelText("Code uit je authenticator-app")).toBeNull();
    fireEvent.change(screen.getByLabelText("Gebruikersnaam"), { target: { value: "Blokgenoot" } });
    fireEvent.change(screen.getByLabelText("Nieuw wachtwoord"), { target: { value: "kort" } });
    fireEvent.change(screen.getByLabelText("Herhaal wachtwoord"), { target: { value: "kort" } });
    fireEvent.click(within(screen.getByTestId("password-login-form")).getByRole("button", { name: "Opslaan" }));
    expect((await screen.findByTestId("password-login-problem")).textContent).toContain("minstens 12 tekens");
    fireEvent.change(screen.getByLabelText("Nieuw wachtwoord"), { target: { value: "een-lang-wachtwoord" } });
    fireEvent.change(screen.getByLabelText("Herhaal wachtwoord"), { target: { value: "een-ander-wachtwoord" } });
    fireEvent.click(within(screen.getByTestId("password-login-form")).getByRole("button", { name: "Opslaan" }));
    expect((await screen.findByTestId("password-login-problem")).textContent).toBe("De wachtwoorden zijn niet gelijk.");
    expect(input(bodies, "account.setPasswordLogin")).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Herhaal wachtwoord"), { target: { value: "een-lang-wachtwoord" } });
    fireEvent.click(within(screen.getByTestId("password-login-form")).getByRole("button", { name: "Opslaan" }));
    await waitFor(() => expect(input(bodies, "account.setPasswordLogin")[0]).toEqual({ username: "blokgenoot", password: "een-lang-wachtwoord" }));
    expect((await screen.findByTestId("password-login-saved")).textContent).toContain("inloggen als blokgenoot");
    expect(card.textContent).toContain("Aan als blokgenoot");

    fireEvent.click(screen.getByTestId("password-login-disable-open"));
    expect(screen.getByText("Backup-login uitzetten?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("password-login-disable-confirm"));
    expect(await screen.findByTestId("password-login-disabled")).toBeTruthy();
    expect(input(bodies, "account.disablePasswordLogin")).toHaveLength(1);
    expect(card.textContent).toContain("Uit");
  });

  it("met 2FA aan is een code verplicht en gaat die mee", async () => {
    const { bodies } = renderWithTrpc(<AccountPage />, {
      session: sessionFor("user", { totpEnabled: true, totpVerified: true }),
      patch: (m) => void (w(m).account.get = () => meOf(true, true)),
    });
    fireEvent.click(await screen.findByTestId("password-login-edit"));
    fireEvent.change(screen.getByLabelText("Gebruikersnaam"), { target: { value: "blokgenoot" } });
    fireEvent.change(screen.getByLabelText("Nieuw wachtwoord"), { target: { value: "een-lang-wachtwoord" } });
    fireEvent.change(screen.getByLabelText("Herhaal wachtwoord"), { target: { value: "een-lang-wachtwoord" } });
    const save = within(screen.getByTestId("password-login-form")).getByRole("button", { name: "Opslaan" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Code uit je authenticator-app"), { target: { value: "123456" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(input(bodies, "account.setPasswordLogin")[0]).toEqual({ username: "blokgenoot", password: "een-lang-wachtwoord", code: "123456" }));
    expect(await screen.findByTestId("password-login-saved")).toBeTruthy();
  });

  it("meldt dat een admin het wachtwoord zette", async () => {
    renderWithTrpc(<AccountPage />, {
      session: sessionFor("user"),
      patch: (m) => {
        w(m).account.get = () => meOf(false, false);
        w(m).account.passwordLogin = () => ({ enabled: true, username: "blokgenoot", updatedAt: new Date("2026-11-27T10:00:00Z"), setByAdmin: true });
      },
    });
    expect((await screen.findByTestId("password-login-admin")).textContent).toContain("Verander het zelf");
    expect(screen.getByTestId("password-login-edit").textContent).toBe("Naam of wachtwoord wijzigen");
  });

  it("niet zichtbaar voor het noodaccount", async () => {
    renderWithTrpc(<AccountPage />, { session: sessionFor("user"), patch: (m) => void (w(m).account.get = () => ({ ...meOf(true, true), isEmergency: true })) });
    expect(await screen.findByTestId("totp-card")).toBeTruthy();
    expect(screen.queryByTestId("password-login-card")).toBeNull();
  });
});

describe("admin: backup-login van een gebruiker", () => {
  it("stelt een naam voor, zet aan en toont het wachtwoord eenmalig; uitzetten met bevestiging", async () => {
    const { bodies } = renderWithTrpc(<UserDetail id={2} />, { session: sessionFor("admin") });
    const section = await screen.findByTestId("user-password-login");
    fireEvent.click(await screen.findByTestId("user-pw-edit"));
    const name = screen.getByLabelText("Gebruikersnaam") as HTMLInputElement;
    expect(name.value).toMatch(/^[a-z0-9][a-z0-9._-]{2,31}$/);
    fireEvent.change(name, { target: { value: "jan.de-vries" } });
    fireEvent.click(screen.getByTestId("user-pw-submit"));
    await waitFor(() => expect(input(bodies, "admin.users.setPasswordLogin")[0]).toEqual({ id: 2, username: "jan.de-vries" }));
    expect((await screen.findByTestId("user-password-value")).textContent).toBe("mock-Wachtwoord-1234");
    expect(screen.getByTestId("user-password-generated").textContent).toContain("maar één keer");
    expect(section.textContent).toContain("Aan als jan.de-vries");
    expect(section.textContent).toContain("Ingesteld door een beheerder");
    fireEvent.click(screen.getByTestId("user-password-saved"));
    expect(screen.queryByTestId("user-password-value")).toBeNull();

    fireEvent.click(screen.getByTestId("user-pw-disable"));
    fireEvent.click(await screen.findByTestId("user-pw-disable-confirm"));
    await waitFor(() => expect(input(bodies, "admin.users.disablePasswordLogin")[0]).toEqual({ id: 2 }));
    await waitFor(() => expect(section.textContent).toContain("Uit"));
  });

  it("ongeldige naam: knop uit en uitleg", async () => {
    renderWithTrpc(<UserDetail id={2} />, { session: sessionFor("admin") });
    fireEvent.click(await screen.findByTestId("user-pw-edit"));
    fireEvent.change(screen.getByLabelText("Gebruikersnaam"), { target: { value: "a!" } });
    expect((screen.getByTestId("user-pw-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Gebruik 3–32 tekens/)).toBeTruthy();
  });

  it("suggestUsername schoont de Discord-naam op", () => {
    expect(suggestUsername("Jöhn Doe!", 5)).toBe("john.doe");
    expect(suggestUsername("__Ab", 5)).toBe("user5");
    expect(suggestUsername("._Steve_", 5)).toBe("steve");
    expect(suggestUsername(null, 7)).toBe("user7");
    expect(suggestUsername("x".repeat(40), 1)).toHaveLength(32);
  });
});
