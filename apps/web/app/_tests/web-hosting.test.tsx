// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "@/app/_components/databases/database-manager";
import { DomainManager, LIVE_CHECK_MS } from "@/app/_components/domains/domain-manager";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { renderWithTrpc, sessionFor } from "./utils";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const SITE = "c0ffee00-1234-4abc-8def-0123456789ab";
const count = (bodies: Array<{ path: string }>, p: string) => bodies.filter((b) => b.path === p).length;

describe("serverTabs", () => {
  it("toont tabbladen op basis van type en rechten", () => {
    const keys = (t: Parameters<typeof serverTabs>[0]) => serverTabs(t).map((x) => x.key);
    expect(keys({ uuid: SITE, type: "web", isOwner: true, permissions: ["files.read", "domain.manage", "database.manage"] })).toEqual([
      "console", "files", "domains", "databases", "users", "settings",
    ]);
    expect(keys({ uuid: SITE, type: "game", isOwner: false, permissions: ["console.read", "domain.manage"] })).toEqual(["console", "settings"]);
  });
});

describe("DomainManager", () => {
  it("toont records met kopieerknoppen, SSL-status en uitleg per provider", async () => {
    const { bodies } = renderWithTrpc(<DomainManager uuid={SITE} />, { session: sessionFor("admin") });
    const cards = await screen.findAllByTestId("domain-card");
    expect(cards).toHaveLength(2);
    const first = cards[0]!;
    await within(first).findByTestId("dns-records");
    expect(within(first).getByRole("button", { name: "Waarde 203.0.113.10 kopiëren" })).toBeTruthy();
    expect(within(first).getByTestId("ssl-status").textContent).toBe("SSL wacht");
    expect(within(first).getByTestId("provider-help").textContent).toMatch(/TransIP/);
    expect(within(first).getAllByText("ontbreekt").length).toBeGreaterThan(0);
    await waitFor(() => expect(count(bodies, "domains.check")).toBeGreaterThanOrEqual(2)); // één per domein bij openen
  });

  it("controleert elke 30 seconden opnieuw", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bodies } = renderWithTrpc(<DomainManager uuid={SITE} />, { session: sessionFor("admin") });
    await screen.findAllByTestId("domain-card");
    await waitFor(() => expect(count(bodies, "domains.check")).toBe(2));
    await act(async () => {
      vi.advanceTimersByTime(LIVE_CHECK_MS);
    });
    await waitFor(() => expect(count(bodies, "domains.check")).toBe(4));
  });

  it("toont waarschuwingen: oranje wolk, oud AAAA, CNAME op apex", async () => {
    renderWithTrpc(<DomainManager uuid={SITE} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        const d = m.domains as Mutable<typeof m.domains>;
        d.check = ({ input }) => ({
          domainId: input.id,
          records: [{ type: "A", name: "@", expected: "203.0.113.10", actual: ["104.21.1.1"], status: "cloudflare_proxy" }],
          nameservers: ["ada.ns.cloudflare.com"],
          provider: "cloudflare",
          warnings: ["cloudflare_proxy", "stale_aaaa", "cname_at_apex"],
          checkedAt: new Date(),
        });
      },
    });
    const [card] = await screen.findAllByTestId("domain-card");
    expect((await within(card!).findByTestId("warning-cloudflare_proxy")).textContent).toMatch(/wolk op grijs/);
    expect(within(card!).getByTestId("warning-stale_aaaa").textContent).toMatch(/AAAA/);
    expect(within(card!).getByTestId("warning-cname_at_apex").textContent).toMatch(/CNAME/);
    expect(within(card!).getByTestId("provider-help").textContent).toMatch(/Cloudflare/);
  });

  it("nieuw domein met www-doorsturing", async () => {
    const { bodies } = renderWithTrpc(<DomainManager uuid={SITE} />, { session: sessionFor("admin") });
    await screen.findAllByTestId("domain-card");
    fireEvent.change(screen.getByLabelText("Domein"), { target: { value: "https://Mijnsite.test/" } });
    fireEvent.click(screen.getByRole("button", { name: /Toevoegen/ }));
    await waitFor(() => expect(count(bodies, "domains.add")).toBe(2));
    const adds = bodies.filter((b) => b.path === "domains.add").map((b) => b.input);
    expect(adds[0]).toMatchObject({ uuid: SITE, hostname: "mijnsite.test", wildcard: false });
    expect(adds[1]).toMatchObject({ uuid: SITE, hostname: "www.mijnsite.test", redirectTo: "mijnsite.test" });
    await waitFor(() => expect(screen.getAllByTestId("domain-card")).toHaveLength(4));
  });

  it("weigert een ongeldige hostnaam", async () => {
    const { bodies } = renderWithTrpc(<DomainManager uuid={SITE} />, { session: sessionFor("admin") });
    await screen.findAllByTestId("domain-card");
    fireEvent.change(screen.getByLabelText("Domein"), { target: { value: "geen domein" } });
    fireEvent.click(screen.getByRole("button", { name: /Toevoegen/ }));
    expect(await screen.findByText(/Ongeldige domeinnaam/)).toBeTruthy();
    expect(count(bodies, "domains.add")).toBe(0);
  });
});

describe("DatabaseManager", () => {
  it("toont gegevens, maakt aan en reset het wachtwoord", async () => {
    const { bodies } = renderWithTrpc(<DatabaseManager uuid={SITE} />, { session: sessionFor("admin") });
    const [card] = await screen.findAllByTestId("database-card");
    expect(within(card!).getAllByText("s1_wordpress").length).toBeGreaterThan(0);
    expect(within(card!).queryByText("mock-wachtwoord")).toBeNull(); // verborgen tot je op tonen klikt
    fireEvent.click(within(card!).getAllByRole("button", { name: "Tonen" })[0]!);
    expect(within(card!).getByText("mock-wachtwoord")).toBeTruthy();

    fireEvent.click(within(card!).getByRole("button", { name: /Wachtwoord resetten/ }));
    fireEvent.click(within(card!).getByRole("button", { name: /Nieuw wachtwoord/ }));
    expect(await within(card!).findByText("nieuw-mock-wachtwoord")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Naam"), { target: { value: "shop-db" } });
    fireEvent.click(screen.getByRole("button", { name: /Aanmaken/ }));
    expect(await screen.findByText(/Alleen letters/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Naam"), { target: { value: "shop" } });
    fireEvent.click(screen.getByRole("button", { name: /Aanmaken/ }));
    await waitFor(() => expect(screen.getAllByTestId("database-card")).toHaveLength(2));
    expect(bodies.find((b) => b.path === "databases.create")?.input).toMatchObject({ uuid: SITE, name: "shop" });
  });
});
