// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserDetail } from "@/app/_components/admin/user-detail";
import { describeAgent } from "@/app/_components/account/sessions-card";
import { renderWithTrpc, sessionFor } from "./utils";

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => "/account",
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

const { default: AccountPage } = await import("@/app/(panel)/account/page");
const { default: LoginPage } = await import("@/app/login/page");

afterEach(() => {
  cleanup();
  nav.replace.mockReset();
});
const input = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);
const user = { session: sessionFor("user") };

describe("account: herstelcodes", () => {
  it("2FA aanzetten toont eenmalig 10 herstelcodes", async () => {
    renderWithTrpc(<AccountPage />, user);
    fireEvent.click(await screen.findByTestId("totp-setup"));
    fireEvent.change(await screen.findByLabelText("Code uit de app"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Bevestigen en aanzetten/ }));
    expect(await screen.findByTestId("recovery-codes")).toBeTruthy();
    expect(screen.getAllByTestId("recovery-code")).toHaveLength(10);
    fireEvent.click(screen.getByTestId("recovery-saved"));
    await waitFor(() => expect(screen.queryByTestId("recovery-codes")).toBeNull());
    expect(await screen.findByTestId("recovery-card")).toBeTruthy();
  });

  it("toont de teller, waarschuwt bij 2 of minder en regenereert met een TOTP-code", async () => {
    const { bodies } = renderWithTrpc(<AccountPage />, {
      session: sessionFor("user", { totpEnabled: true, totpVerified: true }),
      patch: (m) => {
        m.account.get = ({ ctx }) => ({ user: { id: 2, discordId: "100000000000000002", name: "blokgenoot", avatarUrl: null }, isAdmin: false, isOwner: false, isEmergency: false, totpEnabled: true, totpVerified: !!ctx });
        m.account.recoveryCodesStatus = () => ({ remaining: 2, total: 10 });
      },
    });
    expect((await screen.findByTestId("recovery-left")).textContent).toContain("Nog 2 van de 10");
    expect(screen.getByTestId("recovery-low")).toBeTruthy();
    fireEvent.click(screen.getByTestId("recovery-regen-open"));
    fireEvent.change(await screen.findByLabelText("Huidige code uit de app", { selector: "#recovery-regen-code" }), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Nieuwe codes maken" }));
    expect(await screen.findByTestId("recovery-codes")).toBeTruthy();
    expect(input(bodies, "account.regenerateRecoveryCodes")[0]).toEqual({ code: "123456" });
  });
});

describe("account: sessies", () => {
  it("toont sessies met 'dit apparaat', uitloggen per sessie en overal elders", async () => {
    const { bodies } = renderWithTrpc(<AccountPage />, user);
    const rows = await screen.findAllByTestId("session-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Dit apparaat");
    expect(rows[0]!.textContent).toContain("Firefox · Linux");
    expect(within(rows[0]!).queryByRole("button")).toBeNull();
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Uitloggen" }));
    await waitFor(() => expect(input(bodies, "account.revokeSession")[0]).toEqual({ id: "00000000-0000-4000-8000-000000000002" }));
    await waitFor(() => expect(screen.getAllByTestId("session-row")).toHaveLength(1));
    expect(screen.queryByTestId("sessions-revoke-others")).toBeNull();
  });

  it("overal elders uitloggen", async () => {
    const { bodies } = renderWithTrpc(<AccountPage />, user);
    fireEvent.click(await screen.findByTestId("sessions-revoke-others"));
    await waitFor(() => expect(bodies.some((b) => b.path === "account.revokeOtherSessions")).toBe(true));
    await waitFor(() => expect(screen.getAllByTestId("session-row")).toHaveLength(1));
  });

  it("herkent browser en besturingssysteem", () => {
    expect(describeAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1", "?")).toBe("Safari · iOS");
    expect(describeAgent(null, "Onbekend")).toBe("Onbekend");
  });
});

describe("login: herstelcode", () => {
  const pending = sessionFor("user", { totpEnabled: true, totpVerified: false });
  it("wisselt naar een herstelcode en stuurt die mee", async () => {
    const { bodies } = renderWithTrpc(<LoginPage />, {
      session: pending,
      patch: (m) => {
        m.auth.verifyTotp = () => ({ ok: true as const, recoveryCodesLeft: 7 });
      },
    });
    fireEvent.click(await screen.findByTestId("toggle-recovery"));
    fireEvent.change(screen.getByLabelText("Herstelcode"), { target: { value: " abcde-fghjk " } });
    fireEvent.click(screen.getByRole("button", { name: "Bevestigen" }));
    await waitFor(() => expect(input(bodies, "auth.verifyTotp")[0]).toEqual({ code: "abcde-fghjk" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/"));
  });

  it("waarschuwt na inloggen met een herstelcode als er bijna geen over zijn", async () => {
    renderWithTrpc(<LoginPage />, {
      session: pending,
      patch: (m) => {
        m.auth.verifyTotp = () => ({ ok: true as const, recoveryCodesLeft: 1 });
      },
    });
    fireEvent.click(await screen.findByTestId("toggle-recovery"));
    fireEvent.change(screen.getByLabelText("Herstelcode"), { target: { value: "abcde-fghjk" } });
    fireEvent.click(screen.getByRole("button", { name: "Bevestigen" }));
    expect((await screen.findByTestId("recovery-low")).textContent).toContain("Nog maar 1 herstelcode over");
    expect(nav.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/"));
  });
});

describe("admin: sessies van een gebruiker", () => {
  it("overal uitloggen met bevestiging", async () => {
    const { bodies } = renderWithTrpc(<UserDetail id={2} />, { session: sessionFor("admin"), locale: "en" });
    await screen.findByTestId("user-badges");
    fireEvent.click(screen.getByTestId("user-revoke-sessions"));
    fireEvent.click(screen.getAllByRole("button", { name: /Sign out everywhere/ })[0]!);
    await waitFor(() => expect(input(bodies, "admin.users.revokeSessions")[0]).toEqual({ id: 2 }));
  });
});
