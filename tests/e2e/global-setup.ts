/**
 * next dev compileert routes bij het eerste bezoek en laadt de pagina dan een paar keer opnieuw
 * (Fast Refresh): bezoek ze vooraf met een echte browser, ingelogd, zodat de tests stabiel zijn.
 */
import { chromium } from "@playwright/test";
import { env } from "../integration/helpers";
import { asAdmin, asUser } from "./support";

export default async function globalSetup() {
  const base = env("IT_PANEL_URL").replace("127.0.0.1", "localhost");
  const id = "00000000-0000-0000-0000-000000000000";
  const browser = await chromium.launch();
  const visit = async (login: (c: import("@playwright/test").BrowserContext) => Promise<unknown>, routes: string[]) => {
    const ctx = await browser.newContext();
    await login(ctx);
    const page = await ctx.newPage();
    for (const r of routes) {
      for (let pass = 0; pass < 2; pass++) {
        await page.goto(base + r, { waitUntil: "load", timeout: 120_000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      }
    }
    await ctx.close();
  };
  await visit(async () => {}, ["/login", "/status/qa-none", "/verify-email?token=x"]);
  await visit((c) => asUser(c), ["/", `/servers/${id}`, `/servers/${id}/files`, `/servers/${id}/domains`, `/servers/${id}/databases`, `/servers/${id}/settings`, `/servers/${id}/backups`, `/servers/${id}/schedules`, `/servers/${id}/content`, `/servers/${id}/network`, `/servers/${id}/bedrock`, `/servers/${id}/apps`, `/servers/${id}/users`, `/servers/${id}/stats`, "/account", "/servers/new", "/databases", "/plans", "/billing", "/status-pages"]);
  await visit((c) => asAdmin(c), ["/admin", "/admin/servers", "/admin/servers/new", `/admin/servers/${id}`, "/admin/users", "/admin/settings", "/admin/nodes", "/admin/nodes/1", "/admin/templates", "/admin/activity", "/admin/settings/database-hosts", "/admin/settings/dns-providers", "/admin/settings/backup-storage", "/admin/settings/image-updates", "/admin/settings/email", "/admin/settings/billing", "/admin/plans", "/admin/billing"]);
  await browser.close();
}
