// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AppJob, AppSummary } from "@panel/api";
import { AppsManager } from "@/app/_components/apps/apps-manager";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { renderWithTrpc, sessionFor } from "./utils";

afterEach(cleanup);
const SITE = "c0ffee00-1234-4abc-8def-0123456789ab";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const job = (over: Partial<AppJob> = {}): AppJob => ({
  id: 77,
  serverUuid: SITE,
  appId: "wordpress",
  appName: "WordPress",
  status: "running",
  steps: ["prepare", "download", "verify", "upload", "extract", "database", "configure", "finish"].map((key) => ({ key, status: "pending" as const })),
  errorCode: null,
  error: null,
  result: null,
  startedAt: new Date(),
  finishedAt: null,
  ...over,
});

describe("Apps tab", () => {
  it("only for websites with files.write", () => {
    const keys = (t: Parameters<typeof serverTabs>[0]) => serverTabs(t).map((x) => x.key);
    expect(keys({ uuid: SITE, type: "web", isOwner: true, permissions: ["files.read", "files.write"] })).toContain("apps");
    expect(keys({ uuid: SITE, type: "web", isOwner: false, permissions: ["files.read"] })).not.toContain("apps");
    expect(keys({ uuid: SITE, type: "game", isOwner: true, permissions: ["files.read", "files.write"] })).not.toContain("apps");
  });
});

describe("AppsManager", () => {
  it("shows the catalogue; incompatible apps are disabled with a reason", async () => {
    renderWithTrpc(<AppsManager uuid={SITE} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        const a = m.apps as Mutable<typeof m.apps>;
        const orig = a.catalog;
        a.catalog = (o) => (orig(o) as AppSummary[]).map((x, i) => (i === 2 ? { ...x, compatible: false, incompatibleReason: "no php" } : x)) as never;
      },
    });
    const cards = await screen.findAllByTestId("app-card");
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByText("WordPress")).toBeTruthy();
    expect(within(cards[0]!).getByText("Maakt een database aan")).toBeTruthy();
    expect(within(cards[1]!).getByText("Geen database nodig")).toBeTruthy();
    expect((within(cards[2]!).getByRole("button", { name: "Installeren" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(cards[2]!).getByText("Vereist een PHP-website")).toBeTruthy();
  });

  it("installs WordPress with an admin: validates, sends the input, shows the result and the password once", async () => {
    const { bodies } = renderWithTrpc(<AppsManager uuid={SITE} />, { session: sessionFor("admin") });
    fireEvent.click(within((await screen.findAllByTestId("app-card"))[0]!).getByRole("button", { name: "Installeren" }));
    await screen.findByTestId("install-form");
    const start = await screen.findByRole("button", { name: "WordPress installeren" });
    fireEvent.change(screen.getByLabelText("E-mailadres"), { target: { value: "not-an-email" } });
    fireEvent.click(start);
    expect(await screen.findByText("Vul een geldig e-mailadres in")).toBeTruthy();
    expect(bodies.filter((b) => b.path === "apps.install")).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("E-mailadres"), { target: { value: "boss@panel.test" } });
    fireEvent.change(screen.getByLabelText("Gebruikersnaam"), { target: { value: "boss" } });
    fireEvent.click(start);
    const result = await screen.findByTestId("job-result");
    expect(bodies.find((b) => b.path === "apps.install")!.input).toEqual({ uuid: SITE, appId: "wordpress", replaceExisting: false, admin: { username: "boss", email: "boss@panel.test" } });
    expect(within(result).getByTestId("admin-url").getAttribute("href")).toBe("https://mock.example.test/wp-admin/");
    expect(within(result).getByText("mock-admin-password")).toBeTruthy();
    expect(screen.getByText(/maar één keer getoond/)).toBeTruthy();
    expect(screen.getByText("WordPress 6.8 is geïnstalleerd.")).toBeTruthy();
  });

  it("an app without admin support starts directly and a non-empty public/ needs confirmation", async () => {
    const { bodies } = renderWithTrpc(<AppsManager uuid={SITE} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        (m.apps as Mutable<typeof m.apps>).check = () => ({ publicEmpty: false, entries: 12 });
      },
    });
    fireEvent.click(within((await screen.findAllByTestId("app-card"))[1]!).getByRole("button", { name: "Installeren" }));
    expect(await screen.findByText(/public\/ bevat al 12 items/)).toBeTruthy();
    expect(screen.queryByLabelText("Gebruikersnaam")).toBeNull();
    const start = screen.getByRole("button", { name: "Grav installeren" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Ja, verwijder de huidige inhoud/));
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await screen.findByTestId("job-result");
    expect(bodies.find((b) => b.path === "apps.install")!.input).toMatchObject({ appId: "grav", replaceExisting: true, admin: null });
  });

  it("shows progress per step while running, then a translated error", async () => {
    let polls = 0;
    renderWithTrpc(<AppsManager uuid={SITE} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        const a = m.apps as Mutable<typeof m.apps>;
        a.install = () => job({ steps: job().steps.map((s, i) => ({ ...s, status: i === 0 ? "done" : i === 1 ? "running" : "pending" })) });
        a.job = () => {
          polls++;
          return polls < 2
            ? job({ steps: job().steps.map((s, i) => ({ ...s, status: i === 0 ? "done" : i === 1 ? "running" : "pending" })) })
            : job({ status: "failed", errorCode: "CHECKSUM_MISMATCH", error: "sha1 mismatch", steps: job().steps.map((s, i) => ({ ...s, status: i < 2 ? "done" : i === 2 ? "failed" : "pending" })) });
        };
      },
    });
    fireEvent.click(within((await screen.findAllByTestId("app-card"))[0]!).getByRole("button", { name: "Installeren" }));
    fireEvent.click(await screen.findByLabelText("Een beheerdersaccount aanmaken")); // no admin
    fireEvent.click(await screen.findByRole("button", { name: "WordPress installeren" }));
    const steps = await screen.findByTestId("job-steps");
    await waitFor(() => expect(within(steps).getByText("Downloaden van de officiële bron").closest("li")!.getAttribute("data-status")).toBe("running"));
    const err = await screen.findByTestId("job-error", undefined, { timeout: 4000 });
    expect(err.textContent).toMatch(/komt niet|kwam niet overeen met de gepubliceerde checksum/);
    expect(within(steps).getByText("Checksum controleren").closest("li")!.getAttribute("data-status")).toBe("failed");
  });

  it("keeps the one-time password on screen when a refetch no longer returns it", async () => {
    let n = 0;
    const done = (pw: string | null) => job({ status: "succeeded", steps: job().steps.map((s) => ({ ...s, status: "done" as const })), result: { version: "6.8", siteUrl: null, adminUrl: null, adminUsername: "boss", adminPassword: pw, databaseName: "db", notes: ["add_domain"] }, finishedAt: new Date() });
    const { queryClient } = renderWithTrpc(<AppsManager uuid={SITE} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        const a = m.apps as Mutable<typeof m.apps>;
        a.jobs = () => [done(null)];
        a.job = () => done(n++ === 0 ? "Secret-Pw-1" : null);
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /WordPress: geïnstalleerd/ }));
    await screen.findByText("Secret-Pw-1");
    await queryClient.invalidateQueries();
    await waitFor(() => expect(n).toBeGreaterThan(1));
    expect(screen.getByText("Secret-Pw-1")).toBeTruthy();
    expect(screen.getByText("Voeg onder Domeinen een domein toe om je website te bereiken.")).toBeTruthy();
  });

  it("adopts a running installation after a reload and works in English", async () => {
    renderWithTrpc(<AppsManager uuid={SITE} />, {
      session: sessionFor("admin"),
      locale: "en",
      patch: (m) => {
        const a = m.apps as Mutable<typeof m.apps>;
        a.jobs = () => [job()];
        a.job = () => job();
      },
    });
    const steps = await screen.findByTestId("job-steps");
    expect(within(steps).getByText("Verifying the checksum")).toBeTruthy();
  });
});
