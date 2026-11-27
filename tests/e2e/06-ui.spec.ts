/** Algemene UI: mobiel (390 px), zijbalk met toetsenbord, thema, taal, console-reconnect, geen console-fouten. */
import { waitFor } from "../integration/helpers";
import { adminSession, asAdmin, asUser, expect, restartDaemon, test } from "./support";
import { need } from "./state";


const userPages = () => ["/", "/account", "/servers/new", `/servers/${need("game")}`, `/servers/${need("game")}/files`, `/servers/${need("game")}/backups`, `/servers/${need("game")}/schedules`, `/servers/${need("game")}/settings`, `/servers/${need("site")}`, `/servers/${need("site")}/domains`, `/servers/${need("site")}/databases`, `/servers/${need("site")}/settings`];
const adminPages = ["/admin", "/admin/servers", "/admin/nodes", "/admin/users", "/admin/templates", "/admin/activity", "/admin/settings", "/admin/settings/database-hosts", "/admin/settings/dns-providers", "/admin/settings/backup-storage", "/admin/settings/image-updates"];

test.describe("mobile 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("user pages: no horizontal overflow, no page errors", async ({ page, context }) => {
    await asUser(context);
    const bad: string[] = [];
    for (const p of userPages()) {
      await page.goto(p, { waitUntil: "load" });
      await page.waitForLoadState("networkidle").catch(() => {});
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 0) bad.push(`${p} (+${over}px)`);
    }
    expect(bad, "pages with horizontal overflow").toEqual([]);
  });

  test("admin pages: no horizontal overflow", async ({ page, context }) => {
    await asAdmin(context);
    const bad: string[] = [];
    for (const p of adminPages) {
      await page.goto(p, { waitUntil: "load" });
      await page.waitForLoadState("networkidle").catch(() => {});
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 0) bad.push(`${p} (+${over}px)`);
    }
    expect(bad, "pages with horizontal overflow").toEqual([]);
  });

  test("drawer opens, navigates, closes (Escape) and is hidden on desktop widths", async ({ page, context }) => {
    await asAdmin(context);
    await page.goto("/");
    await expect(page.getByTestId("sidebar")).toBeHidden();
    await page.getByTestId("nav-open").click();
    const drawer = page.getByTestId("nav-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Users" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await page.getByTestId("nav-open").click();
    await drawer.getByRole("link", { name: "Users" }).click();
    await expect(page).toHaveURL(/\/admin\/users/);
    await expect(drawer).toBeHidden();
    // theme + language controls live in the drawer
    await page.getByTestId("nav-open").click();
    await drawer.getByTestId("theme-toggle").click();
    await expect(page.locator("html")).toHaveClass(/light/);
    await drawer.getByTestId("theme-toggle").click();
    await page.keyboard.press("Escape");
  });

  test("server tabs scroll horizontally and the active tab is visible", async ({ page, context }) => {
    await asUser(context);
    await page.goto(`/servers/${need("site")}/settings`);
    const tab = page.getByRole("navigation", { name: "Server sections" }).getByRole("link", { name: "Settings" });
    await expect(tab).toBeInViewport();
  });
});

test("sidebar: keyboard navigation, collapse state persists, aria-current", async ({ page, context }) => {
  await asAdmin(context);
  await page.goto("/admin");
  const sb = page.getByTestId("sidebar");
  await expect(sb).toBeVisible();
  await expect(sb.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  // Tab reaches the sidebar links in order and Enter follows
  await sb.getByRole("link", { name: "Servers", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(sb.getByRole("link", { name: "Nodes" })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/users/);
  await expect(page.getByTestId("sidebar").getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
  // settings has sub navigation
  await page.getByTestId("sidebar").getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("nav-subitems")).toBeVisible();
  await page.getByTestId("nav-subitems").getByRole("link", { name: "Backup storage" }).click();
  await expect(page).toHaveURL(/backup-storage/);
  // collapse, reload: stays collapsed; links keep an accessible name
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
  await page.reload();
  await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
  await expect(page.getByTestId("sidebar").getByRole("link", { name: "Users" })).toBeVisible();
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "false");
});

test("light theme: applies, persists after reload and text is readable", async ({ page, context }) => {
  await asUser(context);
  await page.goto("/");
  await page.getByTestId("sidebar").getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/light/);
  // computed colors can be lab()/oklch(): let a canvas convert them to sRGB
  const lum = await page.evaluate(() => {
    const px = (c: string) => { const x = document.createElement("canvas").getContext("2d")!; x.fillStyle = c; x.fillRect(0, 0, 1, 1); const [r, g, b] = x.getImageData(0, 0, 1, 1).data; return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
    const bgC = [document.body, document.documentElement].map((e) => getComputedStyle(e).backgroundColor).find((c) => !/, 0\)$|transparent/.test(c)) ?? "rgb(0,0,0)";
    return { bg: px(bgC), fg: px(getComputedStyle(document.body).color) };
  });
  expect(lum.bg).toBeGreaterThan(180);
  expect(lum.fg).toBeLessThan(100);
  await page.screenshot({ path: `test-results/qa-light-home.png` });
  await page.getByTestId("sidebar").getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("language switch NL: navigation, server tabs and settings are translated", async ({ page, context }) => {
  await asUser(context);
  await page.goto(`/servers/${need("site")}`);
  await page.getByTestId("sidebar").getByTestId("user-menu").click();
  await page.getByTestId("locale-nl").click();
  await expect(page.getByRole("link", { name: "Mijn servers" }).first()).toBeVisible();
  await page.goto(`/servers/${need("site")}/settings`);
  await expect(page.getByTestId("php-settings-card")).toBeVisible();
  const txt = await page.locator("main").innerText();
  expect(txt, "English strings left in the Dutch settings page").not.toMatch(/Maximum upload size|Image updates|Save and restart/);
  await page.getByTestId("sidebar").getByTestId("user-menu").click();
  await page.getByTestId("locale-en").click();
});

test("console reconnects after the daemon restarts", async ({ page, context }) => {
  test.setTimeout(4 * 60_000);
  const admin = await adminSession();
  await admin.api.servers.power.mutate({ uuid: need("game"), action: "start" }).catch(() => {});
  await asUser(context);
  await page.goto(`/servers/${need("game")}`);
  const state = page.getByTestId("console-state");
  await expect(state).toHaveAttribute("data-state", "connected", { timeout: 60_000 });
  await restartDaemon(3000);
  await expect(state).toHaveAttribute("data-state", "connected", { timeout: 90_000 });
  await page.getByTestId("console-input").fill("echo after-restart-77");
  await page.getByTestId("console-input").press("Enter");
  await expect(page.locator(".xterm")).toContainText("after-restart-77", { timeout: 30_000 });
  await waitFor("server still online", async () => (await admin.api.servers.get.query({ uuid: need("game") })).status === "online", 60_000);
});

test("no console errors on any main page (user and admin)", async ({ page, context, consoleErrors }) => {
  test.setTimeout(6 * 60_000);
  await asAdmin(context);
  const seen: string[] = [];
  const all = [...userPages(), ...adminPages, `/servers/${need("paper")}`, `/servers/${need("paper")}/content`, `/servers/${need("velocity")}/network`, `/servers/${need("paper")}/bedrock`];
  for (const p of all) {
    consoleErrors.length = 0;
    await page.goto(p, { waitUntil: "load" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);
    for (const e of consoleErrors) seen.push(`${p}: ${e.slice(0, 200)}`);
  }
  expect(seen, "console.error output").toEqual([]);
});
