/**
 * phpMyAdmin ingebed op /databases: echte phpMyAdmin-container (deploy/phpmyadmin) tegen de test-MariaDB,
 * achter een proxy op dezelfde origin als het panel (zoals Caddy). Inloggen gaat via de eenmalige sign-on.
 */
import { login } from "../integration/helpers";
import { startPhpMyAdmin } from "./fakes";
import { asUser, expect, test, USER } from "./support";
import { need } from "./state";

test.describe.configure({ mode: "serial" });

let pma: Awaited<ReturnType<typeof startPhpMyAdmin>> | null = null;
let dbName = "";

test.beforeAll(async () => {
  test.skip(!process.env.IT_PMA_IMAGE, "phpMyAdmin image not built (see run.sh)");
  pma = await startPhpMyAdmin();
  const api = (await login(USER.id, USER.name)).api;
  dbName = (await api.databases.list.query({ uuid: need("site") }))[0]!.name;
});

test.afterAll(async () => {
  await pma?.stop();
});

test("databases page embeds phpMyAdmin, signed in, theme follows panel_theme", async ({ page, context }) => {
  await asUser(context);
  await page.goto(`${pma!.origin}/databases`);
  await expect(page.getByTestId("phpmyadmin-page")).toBeVisible();
  const frameEl = page.getByTestId("phpmyadmin-frame");
  await expect(frameEl).toBeVisible({ timeout: 60_000 });
  const frame = page.frameLocator('[data-testid="phpmyadmin-frame"]');
  // ingelogd: de navigatie toont de database van de gebruiker (en geen inlogformulier)
  await expect(frame.locator("#pma_navigation_tree").getByText(dbName, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(frame.locator("#input_username")).toHaveCount(0);
  // ingebed: class panel-embed, standaard donker
  const html = frame.locator("html");
  await expect(html).toHaveClass(/panel-embed/);
  await expect(html).toHaveClass(/panel-dark/);
  // thema wisselen in het panel: phpMyAdmin wisselt live mee (storage-event, zelfde origin)
  await page.getByTestId("sidebar").getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveClass(/light/);
  await expect(html).toHaveClass(/panel-light/);
  await page.getByTestId("sidebar").getByTestId("theme-toggle").click();
  await expect(html).toHaveClass(/panel-dark/);
});

test("deep link ?db= opens that database directly", async ({ page, context }) => {
  await asUser(context);
  await page.goto(`${pma!.origin}/databases?db=${encodeURIComponent(dbName)}`);
  const frameEl = page.getByTestId("phpmyadmin-frame");
  await expect(frameEl).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.frames().find((f) => f.url().includes("/phpmyadmin/"))?.url() ?? "", { timeout: 60_000 }).toContain(`db=${dbName}`);
  const frame = page.frameLocator('[data-testid="phpmyadmin-frame"]');
  await expect(frame.locator("#page_content, .page_content, body").first()).toContainText(dbName, { timeout: 30_000 });
});

test("a database that isn't yours is not opened via ?db=", async ({ page, context }) => {
  await asUser(context);
  await page.goto(`${pma!.origin}/databases?db=mysql`);
  await expect(page.getByTestId("phpmyadmin-frame")).toBeVisible({ timeout: 60_000 });
  const frame = page.frameLocator('[data-testid="phpmyadmin-frame"]');
  await expect(frame.locator("body")).toBeVisible();
  await page.waitForTimeout(2000);
  const tree = await frame.locator("#pma_navigation_tree").innerText().catch(() => "");
  expect(tree).not.toMatch(/\bmysql\b/);
});
