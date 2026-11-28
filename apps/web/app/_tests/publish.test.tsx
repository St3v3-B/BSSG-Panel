// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Implementation, PublishInfo, PublishJob, ServerDetail } from "@panel/api";
import { PublishManager, StagingBanner } from "@/app/_components/publish/publish-manager";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/", useParams: () => ({}) }));
beforeAll(() => {
  process.env.NEXT_PUBLIC_PANEL_MOCK = "1";
});
afterEach(cleanup);

const SITE = "c0ffee00-1234-4abc-8def-0123456789ab"; // website van de admin
const PROD = "11111111-2222-4333-8444-555555555555";
const MOCK_DEFAULT_EXCLUDES: PublishInfo["defaultExcludes"] = [
  { pattern: "wp-config.php", kind: "wp_config" },
  { pattern: ".env", kind: "env" },
  { pattern: "/php/00-panel.ini", kind: "panel_settings" },
  { pattern: "public/wp-content/uploads/", kind: "uploads" },
];
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

async function loadServer(uuid: string): Promise<ServerDetail> {
  const { buildRouter } = await import("@panel/api");
  const { createMock } = await import("@panel/api/mock");
  const caller = buildRouter(createMock()).createCaller({ session: sessionFor("admin"), ip: null, userAgent: null, resHeaders: new Headers() } as never);
  return (await caller.servers.get({ uuid })) as ServerDetail;
}

const stagingInfo = (o: Partial<PublishInfo> = {}): PublishInfo => ({
  role: "staging",
  isWeb: true,
  production: { uuid: PROD, name: "Shop", sameNode: true },
  stagings: [],
  canPublish: true,
  reason: null,
  backupAvailable: false,
  databases: [{ from: "sc0ffee00_wordpress", to: "s11111111_wordpress" }],
  unmatchedDatabases: [],
  defaultExcludes: MOCK_DEFAULT_EXCLUDES,
  app: "wordpress",
  stagingHost: "staging.shop.test",
  productionHost: "shop.test",
  notes: ["production_git_deploy"],
  running: null,
  ...o,
});

const job = (status: PublishJob["status"]): PublishJob => ({
  id: 77,
  status,
  staging: { uuid: SITE, name: "Shop (staging)", exists: true },
  production: { uuid: PROD, name: "Shop", exists: true },
  steps: [
    { key: "backup", status: "skipped" },
    { key: "prepare", status: "done" },
    { key: "stop", status: "done" },
    { key: "files", status: status === "failed" ? "failed" : "done" },
    { key: "databases", status: "done" },
    { key: "start", status: "done" },
    { key: "finish", status: status === "failed" ? "skipped" : "done" },
  ],
  options: { files: true, databases: true, exclude: [], rewriteUrls: true, backup: false, sameNode: true },
  backupId: null,
  databases: [{ from: "sc0ffee00_wordpress", to: "s11111111_wordpress" }],
  kept: ["/wp-config.php"],
  urlRewrite: { from: "staging.shop.test", to: "shop.test", replaced: 12, skipped: 0 },
  warnings: [],
  restored: status === "failed" ? true : null,
  errorCode: status === "failed" ? "DAEMON_INTERNAL" : null,
  error: status === "failed" ? "swap kapot" : null,
  startedAt: new Date(),
  finishedAt: new Date(),
});

function patchPublish(info: PublishInfo, result: PublishJob) {
  return (m: Implementation) => {
    const p = m.publish as { -readonly [K in keyof Implementation["publish"]]: Implementation["publish"][K] };
    p.info = () => info;
    p.start = () => result;
    p.job = () => result;
    p.history = () => [result];
  };
}

describe("staging maken (productie)", () => {
  it("eigenaar/admin: formulier met naam (staging), domein en databases; toont de voortgang van de kopie", async () => {
    const { bodies } = renderWithTrpc(<PublishManager server={await loadServer(SITE)} canCreate />, { session: sessionFor("admin"), locale: "en" });
    await screen.findByTestId("publish-manager");
    expect(screen.getByText("This site has no staging copy yet.")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toMatch(/\(staging\)$/);
    fireEvent.change(screen.getByLabelText("Domain for the staging copy (optional)"), { target: { value: "niet geldig" } });
    expect((screen.getByTestId("create-staging-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Domain for the staging copy (optional)"), { target: { value: "Staging.Shop.test" } });
    fireEvent.click(screen.getByTestId("create-staging-submit"));
    await screen.findByTestId("clone-progress");
    expect(inputs(bodies, "publish.createStaging")[0]).toMatchObject({ uuid: SITE, copyDatabases: true, domain: "staging.shop.test" });
  });

  it("zonder rechten om te maken: geen formulier", async () => {
    renderWithTrpc(<PublishManager server={await loadServer(SITE)} canCreate={false} />, { session: sessionFor("admin"), locale: "en" });
    await screen.findByTestId("publish-manager");
    expect(screen.queryByTestId("create-staging")).toBeNull();
  });
});

describe("publiceren (staging)", () => {
  it("zonder backupdoel: expliciet doorgaan; databases met waarschuwing en bevestiging; uploads volgen de databasekeuze", async () => {
    const { bodies } = renderWithTrpc(<PublishManager server={await loadServer(SITE)} canCreate />, { session: sessionFor("admin"), locale: "en", patch: patchPublish(stagingInfo(), job("succeeded")) });
    expect((await screen.findByTestId("publish-staging")).textContent).toMatch(/Staging of Shop/);
    expect(screen.queryByTestId("create-staging")).toBeNull(); // een staging-site krijgt geen eigen staging-formulier
    fireEvent.click(screen.getByTestId("publish-open"));
    await screen.findByTestId("publish-form");
    const submit = screen.getByTestId("publish-submit") as HTMLButtonElement;
    expect(screen.getByTestId("publish-no-backup").textContent).toMatch(/No backup possible/);
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("publish-skip-backup"));
    expect(submit.disabled).toBe(false);
    expect((screen.getByTestId("publish-exclude-uploads") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("publish-exclude-wp_config") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("publish-notes").textContent).toMatch(/deploys from Git/);

    fireEvent.click(screen.getByTestId("publish-databases"));
    expect(screen.getByTestId("publish-db-warning").textContent).toMatch(/new orders, comments/);
    expect(submit.disabled).toBe(true);
    expect((screen.getByTestId("publish-exclude-uploads") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Replace staging.shop.test with shop.test in the databases")).toBeTruthy();
    fireEvent.click(screen.getByTestId("publish-confirm-db"));
    fireEvent.change(screen.getByLabelText("Other paths to keep (one per line)"), { target: { value: "../etc" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Other paths to keep (one per line)"), { target: { value: "public/cache/\n" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    const progress = await screen.findByTestId("publish-progress");
    await waitFor(() => expect(progress.getAttribute("data-status")).toBe("succeeded"));
    expect(progress.textContent).toMatch(/12 URL\(s\) replaced/);
    expect(progress.textContent).toMatch(/\/wp-config\.php/);
    const sent = inputs(bodies, "publish.start")[0] as { exclude: string[] };
    expect(sent).toMatchObject({ uuid: SITE, files: true, databases: true, confirmDatabases: true, rewriteUrls: true, skipBackup: true });
    expect(sent.exclude).toContain("wp-config.php");
    expect(sent.exclude).toContain("public/cache/");
    expect(sent.exclude).not.toContain("public/wp-content/uploads/");
  });

  it("mislukt: duidelijke melding dat productie is teruggezet; geschiedenis", async () => {
    renderWithTrpc(<PublishManager server={await loadServer(SITE)} canCreate />, { session: sessionFor("admin"), locale: "en", patch: patchPublish(stagingInfo({ running: job("failed") }), job("failed")) });
    const failed = await screen.findByTestId("publish-failed");
    expect(failed.textContent).toMatch(/put back as it was/);
    expect(failed.textContent).toMatch(/swap kapot/);
    expect((await screen.findByTestId("publish-history")).textContent).toMatch(/Shop \(staging\) → Shop/);
  });

  it("geen recht: knop uit met uitleg (Nederlands)", async () => {
    renderWithTrpc(<PublishManager server={await loadServer(SITE)} canCreate />, { session: sessionFor("admin"), patch: patchPublish(stagingInfo({ canPublish: false, reason: "MISSING_PERMISSION: files.write" }), job("succeeded")) });
    expect(((await screen.findByTestId("publish-open")) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("publish-reason").textContent).toMatch(/Je hebt het recht files.write nodig/);
  });

  it("banner op de staging-site en het tabblad", async () => {
    const server = await loadServer(SITE);
    renderWithTrpc(<StagingBanner server={server} />, { session: sessionFor("admin"), locale: "en", patch: patchPublish(stagingInfo(), job("succeeded")) });
    expect((await screen.findByTestId("staging-banner")).textContent).toMatch(/staging copy of Shop/);
    expect(serverTabs({ ...server, permissions: ["files.read"] }).map((t) => t.key)).toContain("staging");
    expect(serverTabs({ ...server, permissions: [] }).map((t) => t.key)).not.toContain("staging");
  });
});
