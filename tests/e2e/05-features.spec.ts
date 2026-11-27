/**
 * Nieuwe features, bediend zoals een gebruiker ze aanklikt: quotum, plugins, backups, schedules,
 * PHP-instellingen, Network (Velocity-nep), Bedrock, image-updates, webhooks.
 * Paper/Velocity zijn alpine-neppen met de juiste slug (tests/e2e/templates/game).
 */
import { login, waitFor } from "../integration/helpers";
import { adminSession, asAdmin, asUser, expect, freePorts, startS3, test, USER } from "./support";
import { need, readState, saveState } from "./state";


const QUOTA_USER = { id: "200000000000000020", name: "kwotum" };
type Admin = Awaited<ReturnType<typeof adminSession>>;

async function mkServer(admin: Admin, name: string, templateName: RegExp, ownerId: number, port?: number) {
  const node = (await admin.api.admin.nodes.list.query()).find((n) => n.isLocal)!;
  const tpl = (await admin.api.admin.templates.list.query()).find((t) => templateName.test(t.name));
  if (!tpl) throw new Error(`template ${templateName} ontbreekt`);
  let allocationIds: number[] = [];
  if (port) {
    await admin.api.admin.allocations.create.mutate({ nodeId: node.id, ip: "127.0.0.1", ports: String(port) });
    const a = (await admin.api.admin.allocations.list.query({ nodeId: node.id })).find((x) => x.port === port)!;
    allocationIds = [a.id];
  }
  const s = await admin.api.admin.servers.create.mutate({ name, ownerId, nodeId: node.id, templateId: tpl.id, limits: { ramMb: 256, diskMb: 1024, cpuPct: 100, swapMb: 0 }, allocationIds, variables: {}, startOnInstall: true });
  return s.uuid;
}

test.beforeAll(async () => {
  const st = readState();
  if (st.paper && st.velocity) return;
  const admin = await adminSession();
  const me = (await login(USER.id, USER.name)).api;
  const userId = (await me.auth.me.query())!.user.id;
  const [p1, p2, p3] = await freePorts(3);
  const paper = await mkServer(admin, "E2E paper", /^Paper$/, userId, p1);
  const velocity = await mkServer(admin, "E2E velocity", /^Velocity$/, userId, p2);
  // extra vrije poort (UDP voor Bedrock) op de node
  const node = (await admin.api.admin.nodes.list.query()).find((n) => n.isLocal)!;
  await admin.api.admin.allocations.create.mutate({ nodeId: node.id, ip: "127.0.0.1", ports: String(p3) });
  saveState({ paper, velocity });
  for (const u of [paper, velocity]) await waitFor("online", async () => (await admin.api.servers.get.query({ uuid: u })).status === "online", 5 * 60_000, 2000);
});

// ---------------------------------------------------------------- quotum

test("quota user creates, sees and cannot exceed their own server quota", async ({ page, context }) => {
  const admin = await adminSession();
  const u = await login(QUOTA_USER.id, QUOTA_USER.name);
  const uid = (await u.api.auth.me.query())!.user.id;
  const node = (await admin.api.admin.nodes.list.query()).find((n) => n.isLocal)!;
  const [port] = await freePorts(1);
  await admin.api.admin.allocations.create.mutate({ nodeId: node.id, ip: "127.0.0.1", ports: String(port) });
  await admin.api.admin.users.setQuota.mutate({ id: uid, maxRamMb: 512, maxDiskMb: 2048, maxCpuPct: 200, maxServers: 1, maxDatabases: 1, templateIds: null, nodeIds: null, maxPortsPerServer: 1 });
  saveState({ quotaUserId: uid });

  await asUser(context, QUOTA_USER.id, QUOTA_USER.name);
  await page.goto("/");
  await expect(page.getByTestId("quota-card")).toBeVisible();
  await page.getByRole("link", { name: /New server/ }).click();
  await expect(page).toHaveURL(/\/servers\/new/);
  await page.getByLabel("Name", { exact: true }).fill("Own sleeper");
  await page.getByLabel("Template").selectOption({ label: "IT sleeper (alleen integratietest)" });
  await page.locator("#own-ram").fill("256");
  await page.locator("#own-disk").fill("512");
  await page.locator("#own-cpu").fill("100");
  await page.getByRole("button", { name: "Create server" }).click();
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]{36}/, { timeout: 30_000 });
  saveState({ quotaUser: page.url().match(/servers\/([0-9a-f-]{36})/)![1] });
  await expect(page.getByRole("heading", { name: "Own sleeper" })).toBeVisible();

  // limit reached: the form says so and the button is disabled
  await page.goto("/servers/new");
  await expect(page.getByText("Your server limit is reached.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create server" })).toBeDisabled();
});

test("quota user can change limits within quota and sees the settings cards", async ({ page, context }) => {
  await asUser(context, QUOTA_USER.id, QUOTA_USER.name);
  await page.goto(`/servers/${need("quotaUser")}/settings`);
  await expect(page.getByRole("heading", { name: "Resources" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Delete server" })).toBeVisible();
  const card = page.getByTestId("own-limits");
  await card.locator("#limit-ram").fill("600"); // quota is 512
  await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
  await card.locator("#limit-ram").fill("384");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
  await page.reload();
  await expect(page.getByTestId("own-limits").locator("#limit-ram")).toHaveValue("384");
});

// BUG (docs/qa-report.md #1): OwnLimitsCard is remounted (key includes the limits) so "Limits saved." vanishes.
test.fixme("quota user: 'Limits saved.' confirmation is shown after saving limits", async ({ page, context }) => {
  await asUser(context, QUOTA_USER.id, QUOTA_USER.name);
  await page.goto(`/servers/${need("quotaUser")}/settings`);
  const card = page.getByTestId("own-limits");
  await card.locator("#limit-ram").fill("320");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("Limits saved.")).toBeVisible();
});

// ---------------------------------------------------------------- plugins

test("plugins tab: search shows hits (Modrinth, real network) or a readable error", async ({ page, context }) => {
  await asUser(context);
  await page.goto(`/servers/${need("paper")}`);
  await page.getByRole("link", { name: "Plugins" }).click();
  await expect(page.getByTestId("content-manager")).toBeVisible();
  await expect(page.getByTestId("content-installed")).toBeVisible();
  await page.getByLabel("Search", { exact: true }).fill("worldedit");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const hit = page.getByTestId("content-hit").first();
  const failed = page.getByTestId("content-search").locator(".text-destructive, [role=alert]").first();
  await expect(hit.or(failed).or(page.getByText("Nothing found for this server's version."))).toBeVisible({ timeout: 45_000 });
  test.skip(!(await hit.isVisible()), "Modrinth not reachable from the test machine");
  await page.getByRole("button", { name: /^Install / }).first().click();
  await expect(page.getByTestId("content-dialog")).toBeVisible();
});

// ---------------------------------------------------------------- backups

test("backups: create (local S3), then restore a deleted file", async ({ page, context }) => {
  test.setTimeout(8 * 60_000);
  const admin = await adminSession();
  const s3 = startS3();
  saveState({ s3: s3.container });
  await admin.api.admin.s3Targets.create.mutate({ name: "qa-s3", endpoint: s3.endpoint, bucket: s3.bucket, region: "us-east-1", pathStyle: true, accessKey: s3.accessKey, secretKey: s3.secretKey });
  const uuid = need("paper");
  const api = (await login(USER.id, USER.name)).api;
  await api.files.write.mutate({ uuid, path: "/qa-marker.txt", content: "before-backup" });

  await asUser(context);
  await page.goto(`/servers/${uuid}/backups`);
  await page.getByLabel("Name", { exact: true }).fill("qa backup");
  await page.getByRole("button", { name: "Create backup" }).click();
  await expect(page.getByText("Backup started.")).toBeVisible();
  const row = page.getByTestId("backup-row").filter({ hasText: "qa backup" });
  await expect(row.getByText("Complete")).toBeVisible({ timeout: 3 * 60_000 });
  await expect(row.getByText(/SHA-256/)).toBeVisible();

  await api.files.delete.mutate({ uuid, paths: ["/qa-marker.txt"] });
  await row.getByRole("button", { name: /Restore/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Yes, restore" }).click();
  await expect(page.getByText("Restore started.").or(row.getByText("Restoring"))).toBeVisible();
  await expect(row.getByText("Complete")).toBeVisible({ timeout: 3 * 60_000 });
  await waitFor("marker back", async () => (await api.files.read.query({ uuid, path: "/qa-marker.txt" })).content === "before-backup", 60_000);
});

// ---------------------------------------------------------------- schedules

test("schedules: create a command schedule and run it now", async ({ page, context }) => {
  const admin = await adminSession();
  await admin.api.servers.power.mutate({ uuid: need("paper"), action: "start" }).catch(() => {});
  await asUser(context);
  await page.goto(`/servers/${need("paper")}/schedules`);
  await page.getByRole("button", { name: "Add schedule" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Say hi");
  await page.getByLabel("Action").selectOption({ label: "Send command" });
  await page.getByLabel("Command").fill("echo schedule-marker-7");
  await page.getByLabel("Pick an example…").selectOption({ label: "Every hour (0 * * * *)" });
  await expect(page.getByTestId("cron-preview").getByRole("listitem").first()).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const row = page.getByTestId("schedule-row").filter({ hasText: "Say hi" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Run now" }).click();
  await expect(row.getByText("Done.")).toBeVisible();
  await expect(row.getByText("Succeeded")).toBeVisible({ timeout: 15_000 });
  // invalid cron is refused in the form
  await page.getByRole("button", { name: "Add schedule" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Bad");
  await page.getByLabel("Time (cron)").fill("61 * * * *");
  await expect(page.getByText("Not a valid cron expression")).toBeVisible();
});

// ---------------------------------------------------------------- PHP

test("PHP settings: save, persist after reload, reject out-of-range memory", async ({ page, context }) => {
  await asUser(context);
  await page.goto(`/servers/${need("site")}/settings`);
  const card = page.getByTestId("php-settings-card");
  await expect(card).toBeVisible();
  await card.getByLabel("Maximum upload size").fill("48");
  await card.getByLabel("Maximum execution time").fill("90");
  await card.getByRole("button", { name: "Save and restart" }).click();
  await expect(card.getByText(/Saved\. The site is restarting/)).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await expect(page.getByTestId("php-settings-card").getByLabel("Maximum upload size")).toHaveValue("48");
  await expect(page.getByTestId("php-settings-card").getByText("Managed by the panel")).toBeVisible();
  await card.getByLabel("Memory limit (memory_limit)").fill("8");
  await expect(card.getByRole("button", { name: "Save and restart" })).toBeDisabled();
  // the settings really landed on disk
  const api = (await login(USER.id, USER.name)).api;
  const ini = await api.files.read.query({ uuid: need("site"), path: "/php/00-panel.ini" });
  expect(ini.content).toMatch(/upload_max_filesize\s*=\s*48M/);
});

// ---------------------------------------------------------------- Bedrock

test("bedrock tab: turn on (real GeyserMC download) and off", async ({ page, context }) => {
  test.setTimeout(6 * 60_000);
  await asUser(context);
  await page.goto(`/servers/${need("paper")}`);
  await page.getByRole("link", { name: "Bedrock" }).click();
  await expect(page.getByTestId("bedrock-manager")).toBeVisible();
  await expect(page.getByTestId("bedrock-state")).toHaveText("Off");
  await page.getByRole("button", { name: "Turn on Bedrock" }).click();
  const on = page.getByTestId("bedrock-state").filter({ hasText: "On" });
  const err = page.getByTestId("bedrock-manager").locator(".text-destructive").first();
  await expect(on.or(err)).toBeVisible({ timeout: 4 * 60_000 });
  test.skip(!(await on.isVisible()), `Bedrock could not be turned on (probably no internet to download.geysermc.org): ${await err.textContent().catch(() => "")}`);
  await expect(page.getByTestId("bedrock-port")).toBeVisible();
  await expect(page.getByTestId("bedrock-firewall")).toBeVisible();
  await page.getByRole("button", { name: "Turn off Bedrock" }).click();
  await expect(page.getByTestId("bedrock-state")).toHaveText("Off", { timeout: 60_000 });
});

// ---------------------------------------------------------------- Network

test("network tab on a Velocity server: add Paper backend, save, velocity.toml updated", async ({ page, context }) => {
  test.setTimeout(5 * 60_000);
  await asUser(context);
  await page.goto(`/servers/${need("velocity")}`);
  await page.getByRole("link", { name: "Network" }).click();
  await expect(page.getByTestId("network-manager")).toBeVisible();
  await expect(page.getByTestId("network-connect")).toBeVisible();
  await page.getByRole("checkbox", { name: "Add E2E paper to the network" }).check();
  await page.getByLabel("Name for E2E paper").fill("e2epaper");
  await page.getByRole("radio", { name: "Make E2E paper the default server" }).check();
  await page.getByRole("button", { name: "Save network" }).click();
  await expect(page.getByTestId("network-confirm")).toBeVisible();
  await page.getByRole("button", { name: "Save and restart" }).click();
  await expect(page.getByTestId("network-result")).toBeVisible({ timeout: 2 * 60_000 });
  const api = (await login(USER.id, USER.name)).api;
  const toml = await api.files.read.query({ uuid: need("velocity"), path: "/velocity.toml" });
  expect(toml.content).toMatch(/e2epaper\s*=\s*"127\.0\.0\.1:\d+"/);
  expect(toml.content).toMatch(/player-info-forwarding-mode\s*=\s*"modern"/);
  // the Paper server now shows the backend notice
  await page.goto(`/servers/${need("paper")}/network`).catch(() => {});
  await page.goto(`/servers/${need("paper")}`);
  await expect(page.getByTestId("backend-notice").or(page.getByText(/behind the proxy/)).first()).toBeVisible({ timeout: 30_000 });
});

// ---------------------------------------------------------------- image updates

test("image-update policy: change to Notify only, persists; admin page lists servers", async ({ page, context }) => {
  await asUser(context);
  await page.goto(`/servers/${need("paper")}/settings`);
  const card = page.getByTestId("image-update-card");
  await expect(card).toBeVisible();
  await card.getByLabel("Policy").selectOption({ label: "Notify only" });
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByTestId("image-update-card").getByLabel("Policy")).toHaveValue("notify");
  const ctx2 = await context.browser()!.newContext();
  await asAdmin(ctx2);
  const p2 = await ctx2.newPage();
  await p2.goto("/admin/settings/image-updates");
  await expect(p2.getByTestId("image-updates-admin")).toBeVisible();
  await expect(p2.getByTestId("image-row").filter({ hasText: "E2E paper" })).toContainText("Notify only");
  await ctx2.close();
});

// BUG (docs/qa-report.md #1): the card is remounted (key includes the policy) so the confirmation vanishes.
test.fixme("image-update policy: shows 'Image update settings saved.' after saving", async ({ page, context }) => {
  await asUser(context);
  await page.goto(`/servers/${need("paper")}/settings`);
  const card = page.getByTestId("image-update-card");
  await card.getByLabel("Policy").selectOption({ label: "Off" });
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByText("Image update settings saved.")).toBeVisible();
});

// ---------------------------------------------------------------- webhooks

test("account webhook card validates the URL", async ({ page, context }) => {
  await asUser(context);
  await page.goto("/account");
  const card = page.getByTestId("account-webhook-card");
  await expect(card).toBeVisible();
  await card.getByLabel("Discord webhook URL").fill("https://example.com/not-discord");
  await expect(card.getByText(/Not a Discord webhook URL/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
  await card.getByLabel("Discord webhook URL").fill("https://discord.com/api/webhooks/123456789/abcdefghij_klmnopqrstuvwxyz-0123");
  await expect(card.getByText(/Not a Discord webhook URL/)).toHaveCount(0);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("account-webhook-card").getByText(/Webhook set/)).toBeVisible();
  await page.getByTestId("account-webhook-card").getByRole("button", { name: "Remove webhook" }).click();
  await expect(page.getByTestId("account-webhook-card").getByText("Webhook removed.")).toBeVisible();
});

test("server notifications card: auto-restart max is bounded 1-20", async ({ page, context }) => {
  await asUser(context);
  await page.goto(`/servers/${need("paper")}/settings`);
  const card = page.getByTestId("server-notifications-card");
  await expect(card).toBeVisible();
  const cb = card.getByLabel("Restart automatically after a crash");
  if (!(await cb.isChecked())) await cb.check();
  await card.getByLabel("Max restarts per 10 minutes").fill("99");
  await expect(card.getByText("Between 1 and 20")).toBeVisible();
  await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("quota user deletes their own server after typing its name; quota is freed", async ({ page, context }) => {
  await asUser(context, QUOTA_USER.id, QUOTA_USER.name);
  await page.goto(`/servers/${need("quotaUser")}/settings`);
  const del = page.getByTestId("delete-own");
  await expect(del.getByRole("button", { name: "Delete this server" })).toBeDisabled();
  await del.getByLabel('Type "Own sleeper" to confirm').fill("Own sleeper");
  await del.getByRole("button", { name: "Delete this server" }).click();
  await expect(page).toHaveURL(/localhost:\d+\/$/, { timeout: 60_000 });
  await expect(page.getByText("Own sleeper")).toHaveCount(0);
  await page.goto("/servers/new");
  await expect(page.getByText("Your server limit is reached.")).toHaveCount(0);
});

test.afterAll(async () => {
  // eigen S3-container (run.sh ruimt ook op via het instance-label)
  const c = readState().s3;
  if (c) await import("node:child_process").then(({ execFileSync }) => { try { execFileSync("docker", ["rm", "-f", c]); } catch {} });
});
