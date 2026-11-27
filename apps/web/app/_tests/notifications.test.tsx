// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { TRPCError } from "@trpc/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountWebhookCard, AdminWebhookCard, ServerNotificationsCard } from "@/app/_components/notifications/webhook-card";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
beforeAll(() => {
  process.env.NEXT_PUBLIC_PANEL_MOCK = "1";
});
afterEach(cleanup);

const GAME = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
const URL1 = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789";
const en = { session: sessionFor("admin"), locale: "en" as const };
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

describe("Discord-meldingen in de UI", () => {
  it("account: ongeldige URL geblokkeerd, geldige opgeslagen, test en verwijderen", async () => {
    const { bodies } = renderWithTrpc(<AccountWebhookCard />, en);
    const input = (await screen.findByLabelText("Discord webhook URL")) as HTMLInputElement;
    expect(screen.getByText("No webhook set.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send test message" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "https://evil.test/hook" } });
    expect(screen.getByText(/Not a Discord webhook URL/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: URL1 } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(inputs(bodies, "account.setWebhook")).toEqual([{ url: URL1 }]);
    // de URL zelf wordt niet meer getoond, alleen een hint
    expect(await screen.findByText(/Webhook set \(…\w{4}\)/)).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    expect(await screen.findByText(/Test message sent/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove webhook" }));
    expect(await screen.findByText("Webhook removed.")).toBeTruthy();
    expect(inputs(bodies, "account.setWebhook")[1]).toEqual({ url: null });
  });

  it("een mislukte test toont een uitleg", async () => {
    renderWithTrpc(<AccountWebhookCard />, {
      ...en,
      patch: (m) => {
        m.account.testWebhook = () => {
          throw new TRPCError({ code: "BAD_REQUEST", message: "WEBHOOK_FAILED" });
        };
        m.account.webhook = () => ({ set: true, hint: "…/webhooks/1/…abcd" });
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Send test message" }));
    expect(await screen.findByText(/Discord did not accept the message/)).toBeTruthy();
  });

  it("server: auto-restart aan met maximum, en een webhook erbij", async () => {
    const { bodies } = renderWithTrpc(<ServerNotificationsCard uuid={GAME} />, en);
    const max = (await screen.findByLabelText("Max restarts per 10 minutes")) as HTMLInputElement;
    expect(max.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(max, { target: { value: "0" } });
    expect(screen.getByText("Between 1 and 20")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(max, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(inputs(bodies, "servers.updateNotifications")[0]).toEqual({ uuid: GAME, autoRestart: true, autoRestartMax: 5 });
    fireEvent.change(screen.getByLabelText("Discord webhook URL"), { target: { value: URL1 } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(inputs(bodies, "servers.updateNotifications")[1]).toEqual({ uuid: GAME, webhookUrl: URL1, autoRestart: true, autoRestartMax: 5 }));
  });

  it("admin en Nederlands", async () => {
    renderWithTrpc(<AdminWebhookCard />, { session: sessionFor("admin"), locale: "nl" });
    expect(await screen.findByText("Beheerdersmeldingen")).toBeTruthy();
    expect(await screen.findByLabelText("Discord-webhook-URL")).toBeTruthy();
    expect(screen.getByText("Geen webhook ingesteld.")).toBeTruthy();
  });
});
