import { adminLogin, env } from "../integration/helpers";
import { asAdmin, asUser, expect, test, USER } from "./support";
import { saveState } from "./state";

test.describe.configure({ mode: "serial" });

test("login page renders", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Sign in with Discord/ }).or(page.getByRole("button", { name: /Sign in with Discord/ }))).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});

test("new user sees the empty overview", async ({ page, context }) => {
  await asUser(context);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "My servers" })).toBeVisible();
  await expect(page.getByText("You don't have any servers yet")).toBeVisible();
});

test("admin creates a game server for the user through /admin", async ({ page, context }) => {
  const admin = await asAdmin(context);
  const node = (await admin.api.admin.nodes.list.query()).find((n) => n.isLocal)!;
  await admin.api.admin.allocations.create.mutate({ nodeId: node.id, ip: "127.0.0.1", ports: env("IT_GAME_PORT") });

  await page.goto("/admin/servers/new");
  await page.getByLabel("Name", { exact: true }).fill("E2E sleeper");
  await page.getByPlaceholder("Search by name or paste a Discord ID").fill(USER.name);
  await page.getByRole("listbox", { name: "Users" }).getByRole("option", { name: new RegExp(USER.name) }).click();
  await page.getByRole("button", { name: "Game server" }).click();
  await page.getByLabel("Template").selectOption({ label: "IT sleeper (alleen integratietest)" });
  await page.getByLabel(`127.0.0.1:${env("IT_GAME_PORT")}`).check();
  await page.getByLabel("Memory (MB)").fill("256");
  await page.getByLabel("Disk (MB)").fill("512");
  await page.getByRole("button", { name: "Create server" }).click();
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]{36}/, { timeout: 30_000 });
  saveState({ game: page.url().match(/servers\/([0-9a-f-]{36})/)![1] });
});

test("admin creates a PHP 8.3 website for the user", async ({ page, context }) => {
  await asAdmin(context);
  await page.goto("/admin/servers/new");
  await page.getByLabel("Name", { exact: true }).fill("E2E site");
  await page.getByPlaceholder("Search by name or paste a Discord ID").fill(USER.name);
  await page.getByRole("listbox", { name: "Users" }).getByRole("option", { name: new RegExp(USER.name) }).click();
  await page.getByRole("button", { name: "Website" }).click();
  await page.getByRole("radiogroup", { name: "Choose a web template" }).getByRole("radio", { name: /PHP 8\.3/ }).click();
  await page.getByLabel("Memory (MB)").fill("512");
  await page.getByLabel("Disk (MB)").fill("2048");
  await page.getByRole("button", { name: "Create server" }).click();
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]{36}/, { timeout: 30_000 });
  saveState({ site: page.url().match(/servers\/([0-9a-f-]{36})/)![1] });
});

test("user overview lists both servers and they come online", async ({ page, context }) => {
  await asUser(context);
  await page.goto("/");
  await expect(page.getByText("E2E sleeper")).toBeVisible();
  await expect(page.getByText("E2E site")).toBeVisible();
  await expect(page.getByText(/2 servers/)).toBeVisible();
  await expect(page.getByText(/2 servers · 2 online/)).toBeVisible({ timeout: 8 * 60_000 });
});
