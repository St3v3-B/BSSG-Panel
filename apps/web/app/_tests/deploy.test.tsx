// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { TRPCError } from "@trpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { DeployConfig } from "@panel/api";
import { DeployManager, looksSsh } from "@/app/_components/deploy/deploy-manager";
import { PermissionPicker } from "@/app/_components/permission-picker";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { renderWithTrpc, sessionFor } from "./utils";

afterEach(cleanup);
const SITE = "c0ffee00-1234-4abc-8def-0123456789ab";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const patchConfig = (over: Partial<DeployConfig>) => (m: Parameters<NonNullable<Parameters<typeof renderWithTrpc>[1]["patch"]>>[0]) => {
  const d = m.deploy as Mutable<typeof m.deploy>;
  const orig = d.config;
  d.config = (async (o: Parameters<typeof orig>[0]) => ({ ...(await orig(o)), ...over })) as never;
};

describe("Deploy tab", () => {
  it("only for websites with deploy.read", () => {
    const keys = (t: Parameters<typeof serverTabs>[0]) => serverTabs(t).map((x) => x.key);
    expect(keys({ uuid: SITE, type: "web", isOwner: false, permissions: ["deploy.read"] })).toContain("deploy");
    expect(keys({ uuid: SITE, type: "web", isOwner: false, permissions: ["files.read", "files.write"] })).not.toContain("deploy");
    expect(keys({ uuid: SITE, type: "game", isOwner: true, permissions: ["deploy.read", "deploy.manage"] })).not.toContain("deploy");
  });

  it("recognises SSH addresses", () => {
    expect(looksSsh("git@github.com:a/b.git")).toBe(true);
    expect(looksSsh("ssh://git@host:2222/a/b")).toBe(true);
    expect(looksSsh("https://github.com/a/b.git")).toBe(false);
  });

  it("deploy.manage in the permission picker also selects deploy.read", () => {
    let value: string[] = [];
    renderWithTrpc(<PermissionPicker value={[]} onChange={(v) => (value = v)} idPrefix="p" />, { session: sessionFor("admin") });
    fireEvent.click(screen.getByLabelText(/Deploys beheren/));
    expect(value).toEqual(["deploy.read", "deploy.manage"]);
  });
});

describe("DeployManager", () => {
  it("shows the connected repository, webhook and history; a failed deploy shows its log and error", async () => {
    renderWithTrpc(<DeployManager uuid={SITE} />, { session: sessionFor("admin") });
    const summary = await screen.findByTestId("deploy-summary");
    expect(within(summary).getByText(/github\.com\/blokgenoten\/site\.git · main/)).toBeTruthy();
    expect(within(summary).getByText("Deployt naar /public")).toBeTruthy();
    expect((await screen.findByTestId("webhook-url")).textContent).toMatch(/\/api\/deploy\/webhook\//);
    expect(screen.getByTestId("webhook-secret").textContent).toBe("mock-webhook-secret-0123456789");
    const rows = await screen.findAllByTestId("deploy-row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText("Mislukt")).toBeTruthy();
    fireEvent.click(rows[1]!);
    const log = await screen.findByTestId("deploy-log");
    expect(log.textContent).toContain('npm ERR! Missing script: "build"');
    expect(screen.getByText("build command exited with code 1")).toBeTruthy();
    expect(screen.getByText("De vorige versie staat nog online.")).toBeTruthy();
  });

  it("deploy now: follows the running deploy live and can cancel it", async () => {
    const { bodies } = renderWithTrpc(<DeployManager uuid={SITE} />, { session: sessionFor("admin") });
    fireEvent.click(await screen.findByTestId("deploy-now"));
    const live = await screen.findByTestId("deploy-live");
    await waitFor(() => expect(within(live).getByTestId("deploy-log").textContent).toContain("Fetching https://github.com/blokgenoten/site.git"));
    expect(within(live).getByText("Code ophalen")).toBeTruthy();
    expect(bodies.some((b) => b.path === "deploy.start")).toBe(true);
    await waitFor(() => expect((screen.getByTestId("deploy-now") as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(within(live).getByTestId("deploy-cancel"));
    await waitFor(() => expect(bodies.some((b) => b.path === "deploy.cancel")).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("deploy-live")).toBeNull(), { timeout: 5000 });
    expect(within((await screen.findAllByTestId("deploy-row"))[0]!).getByText("Afgebroken")).toBeTruthy();
  });

  it("connects a repository over SSH: picks the deploy key, then shows the public key and the verified host", async () => {
    const { bodies } = renderWithTrpc(<DeployManager uuid={SITE} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        const d = m.deploy as Mutable<typeof m.deploy>;
        const orig = d.config;
        let first = true;
        d.config = (async (o: Parameters<typeof orig>[0]) => {
          const c = await orig(o);
          if (!first) return c;
          first = false;
          return { ...c, configured: false, repoUrl: null, webhookUrl: null, webhookSecret: null, buildCommand: null, sharedPaths: [], sourceDir: "/" };
        }) as never;
      },
    });
    await screen.findByTestId("deploy-form");
    fireEvent.change(screen.getByLabelText("Repository-URL"), { target: { value: "git@github.com:blokgenoten/site.git" } });
    await waitFor(() => expect((screen.getByLabelText("Privé (SSH-deploy key)") as HTMLInputElement).checked).toBe(true));
    expect((screen.getByLabelText("Openbare repository") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Gedeelde paden (blijven bij elke deploy bewaard)"), { target: { value: "/.env\n\n /wp-content/uploads " } });
    fireEvent.click(screen.getByRole("button", { name: "Opslaan" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "deploy.configure")).toBeTruthy());
    expect(bodies.find((b) => b.path === "deploy.configure")!.input).toMatchObject({ uuid: SITE, repoUrl: "git@github.com:blokgenoten/site.git", authType: "ssh", branch: "main", targetDir: "/public", sharedPaths: ["/.env", "/wp-content/uploads"], buildCommand: null });
    expect((await screen.findByTestId("deploy-public-key")).textContent).toMatch(/^ssh-ed25519 /);
    expect(within(screen.getByTestId("deploy-hostkey")).getByText("github.com wordt gecontroleerd met de gepubliceerde hostsleutels.")).toBeTruthy();
  });

  it("a token field that keeps the saved token; errors are translated", async () => {
    renderWithTrpc(<DeployManager uuid={SITE} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        patchConfig({ authType: "token", tokenSet: true })(m);
        const d = m.deploy as Mutable<typeof m.deploy>;
        d.configure = (() => {
          throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_REPO_URL" });
        }) as never;
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Instellingen wijzigen" }));
    const token = screen.getByLabelText("Toegangstoken") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.placeholder).toBe("Leeg laten om het opgeslagen token te houden");
    fireEvent.click(screen.getByRole("button", { name: "Opslaan" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Gebruik een https://- of SSH-adres");
  });

  it("read-only subusers see history but no settings, secrets or deploy button", async () => {
    renderWithTrpc(<DeployManager uuid={SITE} />, { session: sessionFor("admin"), patch: patchConfig({ canManage: false, webhookUrl: null, webhookSecret: null }) });
    await screen.findByTestId("deploy-summary");
    expect(screen.queryByTestId("deploy-now")).toBeNull();
    expect(screen.queryByTestId("deploy-webhook")).toBeNull();
    expect(await screen.findAllByTestId("deploy-row")).toHaveLength(3);
  });

  it("no repository and no manage permission: explains who can set it up", async () => {
    renderWithTrpc(<DeployManager uuid={SITE} />, { session: sessionFor("admin"), patch: patchConfig({ configured: false, canManage: false, repoUrl: null }) });
    expect((await screen.findByTestId("deploy-not-configured")).textContent).toContain("Vraag de eigenaar");
    expect(screen.queryByTestId("deploy-form")).toBeNull();
  });

  it("speaks English", async () => {
    renderWithTrpc(<DeployManager uuid={SITE} />, { session: sessionFor("admin"), locale: "en" });
    expect(await screen.findByRole("button", { name: "Deploy now" })).toBeTruthy();
    expect(screen.getByText("History")).toBeTruthy();
  });
});
