import { asAdmin, asUser, expect, test, USER } from "./support";
import { need } from "./state";

test.describe.configure({ mode: "serial" });

test("admin server list filters", async ({ page, context }) => {
  await asAdmin(context);
  await page.goto("/admin/servers");
  await expect(page.getByText("E2E sleeper")).toBeVisible();
  await expect(page.getByText(/E2E (site|rename)/)).toBeVisible();
  await page.getByPlaceholder("Search by name…").fill("sleeper");
  await expect(page.getByText(/E2E (site|rename)/)).toHaveCount(0);
  await expect(page.getByText("E2E sleeper")).toBeVisible();
  await page.getByPlaceholder("Search by name…").fill("nonexistent-zzz");
  await expect(page.getByText("No servers match these filters.")).toBeVisible();
  await page.getByPlaceholder("Search by name…").fill("");
  await page.getByLabel(/^Type/).selectOption({ label: "Website" });
  await expect(page.getByText("E2E sleeper")).toHaveCount(0);
  await expect(page.getByText(/E2E (site|rename)/)).toBeVisible();
});

test("suspend and unsuspend a server", async ({ page, context }) => {
  await asAdmin(context);
  await page.goto(`/admin/servers/${need("game")}`);
  await page.getByLabel("Reason").fill("e2e test");
  await page.getByRole("button", { name: "Suspend server" }).click();
  await expect(page.getByText("Sure?")).toBeVisible();
  await page.getByRole("button", { name: "Suspend server" }).click();
  await expect(page.getByText("Server suspended.")).toBeVisible();
  await expect(page.getByText(/Suspended since/)).toBeVisible();
  await page.getByRole("button", { name: "Unsuspend server" }).click();
  await page.getByRole("button", { name: "Unsuspend server" }).click();
  await expect(page.getByText("Server unsuspended.")).toBeVisible();
});

test("users page lists the accounts", async ({ page, context }) => {
  await asAdmin(context);
  await page.goto("/admin/users");
  await expect(page.getByTestId("users-table").getByRole("link", { name: USER.name })).toBeVisible();
  await expect(page.getByTestId("users-table").getByRole("link", { name: "eigenaar" })).toBeVisible();
  await page.getByPlaceholder("Search by name or Discord ID…").fill(USER.name);
  await expect(page.getByTestId("users-table").getByRole("link", { name: "eigenaar" })).toHaveCount(0);
});

test("settings: panel name is saved and shown in the sidebar", async ({ page, context }) => {
  await asAdmin(context);
  await page.goto("/admin/settings");
  await page.getByLabel("Panel name").fill("E2E Panel");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("sidebar").getByText("E2E Panel")).toBeVisible();
});

test("language switch EN to NL persists after reload", async ({ page, context }) => {
  await asUser(context);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "My servers" })).toBeVisible();
  await page.getByTestId("sidebar").getByTestId("user-menu").click();
  await page.getByTestId("locale-nl").click();
  await expect(page.getByRole("heading", { name: "Mijn servers" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Mijn servers" })).toBeVisible();
  await page.getByTestId("sidebar").getByTestId("user-menu").click();
  await page.getByTestId("locale-en").click();
  await expect(page.getByRole("heading", { name: "My servers" })).toBeVisible();
});

test("language switch on the login page", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("locale-switcher").getByRole("button", { name: "NL" }).click();
  await expect(page.getByRole("heading", { name: "Inloggen" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Inloggen" })).toBeVisible();
});
