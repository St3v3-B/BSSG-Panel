// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { TRPCError } from "@trpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithTrpc } from "./utils";

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => "/login",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

const { default: LoginPage } = await import("@/app/login/page");

afterEach(() => {
  cleanup();
  nav.replace.mockReset();
});

describe("login: noodlogin", () => {
  it("toont een klein 'Noodlogin'-linkje onder Discord", async () => {
    renderWithTrpc(<LoginPage />, { session: null });
    expect(await screen.findByTestId("discord-login")).toBeTruthy();
    expect(screen.getByTestId("emergency-link").textContent).toBe("Noodlogin");
  });

  it("stuurt wachtwoord + code mee en gaat door bij succes", async () => {
    const { bodies } = renderWithTrpc(<LoginPage />, { session: null });
    fireEvent.click(await screen.findByTestId("emergency-link"));
    const submit = await screen.findByRole("button", { name: "Inloggen" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Wachtwoord"), { target: { value: "geheim-genoeg-wachtwoord" } });
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(submit);
    await waitFor(() => expect(bodies.find((b) => b.path === "auth.emergencyLogin")?.input).toEqual({ password: "geheim-genoeg-wachtwoord", code: "123456" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/"));
  });

  it("toont een vertaalde fout bij verkeerde gegevens", async () => {
    renderWithTrpc(<LoginPage />, {
      session: null,
      patch: (m) => {
        (m as unknown as { auth: Record<string, unknown> }).auth.emergencyLogin = () => {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "INVALID_CREDENTIALS" });
        };
      },
    });
    fireEvent.click(await screen.findByTestId("emergency-link"));
    fireEvent.change(await screen.findByLabelText("Wachtwoord"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Inloggen" }));
    expect(await screen.findByText("Wachtwoord of code klopt niet.")).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("terug naar Discord", async () => {
    renderWithTrpc(<LoginPage />, { session: null });
    fireEvent.click(await screen.findByTestId("emergency-link"));
    fireEvent.click(await screen.findByText("Terug naar inloggen met Discord"));
    expect(await screen.findByTestId("discord-login")).toBeTruthy();
  });
});
