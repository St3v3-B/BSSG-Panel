import { asUser, expect, test } from "./support";
import { need } from "./state";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // Herstartbaar: een eerdere run kan de server gestopt hebben.
  const admin = await (await import("../integration/helpers")).adminLogin();
  await admin.api.servers.power.mutate({ uuid: need("game"), action: "start" }).catch(() => {});
});

test("console shows output and echoes a command", async ({ page, context }) => {
  await asUser(context);
  await page.goto(`/servers/${need("game")}`);
  await expect(page.getByTestId("console-state")).toHaveAttribute("data-state", "connected", { timeout: 60_000 });
  // xterm.js tekent in canvas/DOM-rijen; de accessibility-laag bevat de tekst.
  const term = page.locator(".xterm");
  await expect(term).toContainText("ready", { timeout: 30_000 });
  await page.getByTestId("console-input").fill("echo e2e-marker-42");
  await page.getByTestId("console-input").press("Enter");
  await expect(term).toContainText("e2e-marker-42", { timeout: 20_000 });
});

test("stats update while running", async ({ page, context }) => {
  await asUser(context);
  await page.goto(`/servers/${need("game")}`);
  const mem = page.getByTestId("live-stats").getByText(/MB|MiB|KB|KiB/).first();
  await expect(mem).toBeVisible({ timeout: 30_000 });
  const uptime = () => page.getByTestId("live-stats").locator("div.text-lg").last().innerText();
  const a = await uptime();
  await expect.poll(uptime, { timeout: 30_000 }).not.toBe(a);
});

test("power: stop then start", async ({ page, context }) => {
  await asUser(context);
  await page.goto(`/servers/${need("game")}`);
  const power = page.getByTestId("power-buttons");
  await expect(power.getByRole("button", { name: "Stop", exact: true })).toBeEnabled({ timeout: 30_000 });
  await power.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Offline").first()).toBeVisible({ timeout: 60_000 });
  await expect(power.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await power.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByText("Online").first()).toBeVisible({ timeout: 60_000 });
});
