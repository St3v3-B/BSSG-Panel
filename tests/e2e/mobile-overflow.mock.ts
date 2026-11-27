import { expect, test } from "@playwright/test";

const GAME = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
const WEB = "c0ffee00-1234-4abc-8def-0123456789ab";
const PAGES = [
  "/",
  "/account",
  "/servers/new",
  `/servers/${GAME}`,
  `/servers/${GAME}/files`,
  `/servers/${GAME}/databases`,
  `/servers/${GAME}/backups`,
  `/servers/${GAME}/schedules`,
  `/servers/${GAME}/settings`,
  `/servers/${WEB}`,
  `/servers/${WEB}/domains`,
  "/admin",
  "/admin/servers",
  "/admin/nodes",
  "/admin/users",
  "/admin/templates",
  "/admin/activity",
  "/admin/settings",
];

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

for (const theme of ["dark", "light"]) {
  test(`no horizontal overflow at 390px (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("panel_theme", t), theme);
    const bad: string[] = [];
    for (const p of PAGES) {
      await page.goto(p, { waitUntil: "networkidle" });
      await page.waitForTimeout(500);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 0) bad.push(`${p} (+${over}px)`);
    }
    expect(bad, "pages with horizontal overflow").toEqual([]);
  });
}
