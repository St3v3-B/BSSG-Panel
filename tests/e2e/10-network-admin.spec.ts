/**
 * Velocity forced hosts (opslaan + validatie), admin "Mine/All servers" en de Bedrock-tab op Fabric (alleen UI,
 * zonder downloads: de Fabric-server is een alpine-nep met slug fabric, tests/e2e/templates/game/fabric.yaml).
 */
import { login, waitFor } from "../integration/helpers";
import { adminSession, asAdmin, asUser, expect, freePorts, test, USER } from "./support";
import { need, readState, saveState } from "./state";

test.describe.configure({ mode: "serial" });

test("velocity forced hosts: invalid domain is refused, valid one is saved into velocity.toml", async ({ page, context }) => {
  test.setTimeout(4 * 60_000);
  await asUser(context);
  await page.goto(`/servers/${need("velocity")}/network`);
  const mgr = page.getByTestId("network-manager");
  await expect(mgr).toBeVisible();
  // 05 heeft E2E paper als backend "e2epaper" toegevoegd
  await expect(mgr.getByRole("checkbox", { name: "Add E2E paper to the network" })).toBeChecked();
  const fh = mgr.getByTestId("forced-hosts");
  await expect(fh).toBeVisible();
  // eventuele rijen van een vorige run weg
  while ((await fh.getByTestId("forced-host-row").count()) > 0) await fh.getByTestId("forced-host-row").first().getByRole("button", { name: /^Remove/ }).click();
  await fh.getByRole("button", { name: "Add domain" }).click();
  const host = fh.getByRole("textbox", { name: "Domain 1" });
  await host.fill("bad_host");
  await expect(fh.getByText("Enter a domain such as survival.example.com (lowercase, no wildcard).")).toBeVisible();
  await expect(mgr.getByRole("button", { name: "Save network" })).toBeDisabled();
  await host.fill("*.panel.test");
  await expect(fh.getByText(/Enter a domain such as/)).toBeVisible();
  await host.fill("survival.panel.test");
  await expect(fh.getByText(/Enter a domain such as/)).toHaveCount(0);
  // backend kiezen (de standaard is al voorgeselecteerd)
  await expect(fh.getByRole("combobox", { name: "Server for survival.panel.test" })).toHaveValue(need("paper"));
  // dubbel domein
  await fh.getByRole("button", { name: "Add domain" }).click();
  await fh.getByRole("textbox", { name: "Domain 2" }).fill("survival.panel.test");
  await expect(fh.getByText("Each domain may appear only once.")).toBeVisible();
  await expect(mgr.getByRole("button", { name: "Save network" })).toBeDisabled();
  await fh.getByTestId("forced-host-row").nth(1).getByRole("button", { name: /^Remove/ }).click();
  await expect(mgr.getByRole("button", { name: "Save network" })).toBeEnabled();
  await mgr.getByRole("button", { name: "Save network" }).click();
  await expect(page.getByTestId("network-confirm")).toBeVisible();
  await page.getByRole("button", { name: "Save without restarting" }).click();
  await expect(page.getByTestId("network-result")).toBeVisible({ timeout: 2 * 60_000 });
  const api = (await login(USER.id, USER.name)).api;
  await waitFor("velocity.toml forced host", async () => /"survival\.panel\.test"\s*=\s*\[\s*"e2epaper"\s*\]/.test((await api.files.read.query({ uuid: need("velocity"), path: "/velocity.toml" })).content), 30_000, 1000);
  await page.reload();
  await expect(page.getByTestId("forced-hosts").getByRole("textbox", { name: "Domain 1" })).toHaveValue("survival.panel.test");
});

test("admin overview: Mine / All servers toggle, remembered; normal users don't see it", async ({ page, context, browser }) => {
  await asAdmin(context);
  await page.goto("/");
  const scope = page.getByTestId("server-scope");
  await expect(scope).toBeVisible();
  await scope.getByRole("button", { name: "Mine" }).click();
  await expect(page.getByRole("heading", { name: "My servers" })).toBeVisible();
  await expect(page.getByTestId("server-card").filter({ hasText: "E2E sleeper" })).toHaveCount(0);
  await scope.getByRole("button", { name: "All servers" }).click();
  await expect(scope.getByRole("button", { name: "All servers" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "All servers" })).toBeVisible();
  await expect(page.getByTestId("server-card").filter({ hasText: "E2E sleeper" })).toBeVisible();
  await expect(page.getByTestId("server-card").filter({ hasText: "E2E paper" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "All servers" })).toBeVisible();
  await page.getByTestId("server-scope").getByRole("button", { name: "Mine" }).click();
  await expect(page.getByRole("heading", { name: "My servers" })).toBeVisible();

  const ctx = await browser.newContext();
  await asUser(ctx);
  const p = await ctx.newPage();
  await p.goto("/");
  await expect(p.getByRole("heading", { name: "My servers" })).toBeVisible();
  await expect(p.getByTestId("server-scope")).toHaveCount(0);
  await ctx.close();
});

test("bedrock tab on a Fabric server: Fabric text, port picker, no download yet", async ({ page, context }) => {
  test.setTimeout(5 * 60_000);
  let uuid = readState().fabric;
  if (!uuid) {
    const admin = await adminSession();
    const me = (await login(USER.id, USER.name)).api;
    const userId = (await me.auth.me.query())!.user.id;
    const node = (await admin.api.admin.nodes.list.query()).find((n) => n.isLocal)!;
    const tpl = (await admin.api.admin.templates.list.query()).find((t) => t.name === "Fabric")!;
    const [p1, p2] = await freePorts(2);
    await admin.api.admin.allocations.create.mutate({ nodeId: node.id, ip: "127.0.0.1", ports: `${p1},${p2}` });
    const a = (await admin.api.admin.allocations.list.query({ nodeId: node.id })).find((x) => x.port === p1)!;
    const s = await admin.api.admin.servers.create.mutate({ name: "E2E fabric", ownerId: userId, nodeId: node.id, templateId: tpl.id, limits: { ramMb: 256, diskMb: 512, cpuPct: 100, swapMb: 0 }, allocationIds: [a.id], variables: {}, startOnInstall: true });
    uuid = s.uuid;
    saveState({ fabric: uuid });
    await waitFor("fabric online", async () => (await admin.api.servers.get.query({ uuid: s.uuid })).status === "online", 3 * 60_000, 2000);
  }
  await asUser(context);
  await page.goto(`/servers/${uuid}`);
  const tabs = page.getByRole("navigation", { name: "Server sections" });
  await expect(tabs.getByRole("link", { name: "Mods" })).toBeVisible();
  await tabs.getByRole("link", { name: "Bedrock" }).click();
  const mgr = page.getByTestId("bedrock-manager");
  await expect(mgr).toBeVisible();
  await expect(page.getByTestId("bedrock-state")).toHaveText("Off");
  await expect(mgr.getByText(/from Modrinth \(checksum verified\), plus Fabric API if it is missing/)).toBeVisible();
  await expect(mgr.getByLabel("Bedrock port")).toBeVisible();
  await expect(mgr.getByRole("button", { name: "Turn on Bedrock" })).toBeEnabled();
});

test("admin node page: the 'HTTP(S) entry' card renders without errors (local node)", async ({ page, context, consoleErrors }) => {
  const admin = await asAdmin(context);
  const node = (await admin.api.admin.nodes.list.query()).find((n) => n.isLocal)!;
  await page.goto(`/admin/nodes/${node.id}`);
  const card = page.getByTestId("node-http-relay");
  await expect(card).toBeVisible();
  await expect(card).toContainText("HTTP(S) entry");
  await expect(card).toContainText("The local node runs the panel and always uses its own ports 80/443.");
  await page.waitForLoadState("networkidle").catch(() => {});
  expect(consoleErrors, "console errors on the node page").toEqual([]);
});
