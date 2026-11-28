/**
 * Taal (NL zonder Engelse restanten) en mobiel (390 px zonder horizontale overflow) op de nieuwe pagina's.
 * De lijst met Engelse teksten komt uit en.ts/nl.ts: elke Engelse zin die in het Nederlands anders is.
 */
import { login } from "../integration/helpers";
import { en } from "../../apps/web/app/_lib/i18n/en";
import { nl } from "../../apps/web/app/_lib/i18n/nl";
import { asAdmin, asUser, expect, test, USER } from "./support";
import { need, readState } from "./state";

test.describe.configure({ mode: "serial" });

function strings(o: unknown, out: string[] = []): string[] {
  if (typeof o === "string") out.push(o);
  else if (o && typeof o === "object") for (const v of Object.values(o)) strings(v, out);
  return out;
}
/** Engelse UI-zinnen (minstens drie woorden) die niet ook in het Nederlands voorkomen. */
const nlAll = strings(nl).join("\n");
const ENGLISH = [...new Set(strings(en))].filter((s) => s.split(/\s+/).length >= 3 && s.length >= 14 && !nlAll.includes(s));

const userPages = () => {
  const st = readState();
  return [
    "/account",
    "/status-pages",
    "/plans",
    "/billing",
    "/databases",
    `/servers/${need("game")}/stats`,
    `/servers/${need("game")}/files`,
    `/servers/${need("paper")}/backups`,
    `/servers/${need("paper")}/settings`,
    `/servers/${need("velocity")}/network`,
    ...(st.fabric ? [`/servers/${st.fabric}/bedrock`] : []),
  ];
};
const adminPages = ["/admin/settings/email", "/admin/plans", "/admin/billing", "/admin/settings/billing"];

async function englishLeft(page: import("@playwright/test").Page) {
  const txt = await page.locator("body").innerText();
  return ENGLISH.filter((s) => txt.includes(s));
}

test.beforeAll(async () => {
  // statuspagina weer aan voor de mobiele controle
  const api = (await login(USER.id, USER.name)).api;
  await api.statusPages.setServerPage.mutate({ uuid: need("paper"), enabled: true, slug: "qa-paper-status", showAddress: false, showPlayers: true });
});

test("Dutch: the new pages have no English left (user)", async ({ page, context }) => {
  test.setTimeout(5 * 60_000);
  expect(ENGLISH.length).toBeGreaterThan(200);
  await asUser(context);
  await page.goto("/");
  await page.getByTestId("sidebar").getByTestId("user-menu").click();
  await page.getByTestId("locale-nl").click();
  await expect(page.getByRole("heading", { name: "Mijn servers" })).toBeVisible();
  const bad: string[] = [];
  try {
    for (const p of userPages()) {
      await page.goto(p, { waitUntil: "load" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(800);
      for (const s of await englishLeft(page)) bad.push(`${p}: "${s.slice(0, 80)}"`);
    }
    // de statuspagina zonder login, in het Nederlands
    await page.goto("/status/qa-paper-status");
    await expect(page.getByTestId("overall")).toBeVisible();
    for (const s of await englishLeft(page)) bad.push(`/status: "${s.slice(0, 80)}"`);
  } finally {
    await page.goto("/");
    await page.getByTestId("sidebar").getByTestId("user-menu").click();
    await page.getByTestId("locale-en").click();
    await expect(page.getByRole("heading", { name: "My servers" })).toBeVisible();
  }
  expect(bad, "English strings on Dutch pages").toEqual([]);
});

test("Dutch: the new admin pages have no English left", async ({ page, context }) => {
  await asAdmin(context);
  await page.goto("/admin");
  await page.getByTestId("sidebar").getByTestId("user-menu").click();
  await page.getByTestId("locale-nl").click();
  const bad: string[] = [];
  try {
    for (const p of adminPages) {
      await page.goto(p, { waitUntil: "load" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(800);
      for (const s of await englishLeft(page)) bad.push(`${p}: "${s.slice(0, 80)}"`);
    }
  } finally {
    await page.getByTestId("sidebar").getByTestId("user-menu").click();
    await page.getByTestId("locale-en").click();
  }
  expect(bad, "English strings on Dutch admin pages").toEqual([]);
});

test("switching EN → NL on an open page updates everything in place (no reload)", async ({ page, context }) => {
  await asUser(context);
  await page.goto(`/servers/${need("game")}/stats`);
  await expect(page.getByTestId("stats-view")).toBeVisible();
  // controle van de detector zelf: in het Engels vindt hij wel Engelse zinnen
  expect((await englishLeft(page)).length).toBeGreaterThan(0);
  await page.getByTestId("sidebar").getByTestId("user-menu").click();
  await page.getByTestId("locale-nl").click();
  try {
    await expect(page.getByRole("navigation", { name: /Server/ }).getByRole("link", { name: "Statistieken" })).toBeVisible();
    await page.waitForTimeout(500);
    expect(await englishLeft(page)).toEqual([]);
  } finally {
    await page.getByTestId("sidebar").getByTestId("user-menu").click();
    await page.getByTestId("locale-en").click();
  }
});

test.describe("mobile 390px (new pages)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  const overflow = async (page: import("@playwright/test").Page, pages: string[]) => {
    const bad: string[] = [];
    for (const p of pages) {
      await page.goto(p, { waitUntil: "load" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(500);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 0) bad.push(`${p} (+${over}px)`);
    }
    return bad;
  };

  test("user pages: no horizontal overflow", async ({ page, context }) => {
    await asUser(context);
    expect(await overflow(page, [...userPages(), "/status/qa-paper-status"]), "pages with horizontal overflow").toEqual([]);
  });

  test("admin pages: no horizontal overflow", async ({ page, context }) => {
    await asAdmin(context);
    expect(await overflow(page, adminPages), "pages with horizontal overflow").toEqual([]);
  });

  test("file search results and chmod dialog fit on a phone", async ({ page, context }) => {
    await asUser(context);
    await page.goto(`/servers/${need("game")}/files`);
    await page.getByTestId("file-search-form").getByRole("searchbox").fill("*");
    await page.getByTestId("file-search-form").getByRole("button", { name: "Search" }).click();
    await expect(page.getByTestId("search-hit").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Close search" }).click();
    await expect(page.getByTestId("file-search-results")).toHaveCount(0);
    await page.getByRole("button", { name: "qa-dir", exact: true }).click();
    await page.getByRole("button", { name: "sub", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Path" })).toContainText("sub");
    await page.getByRole("button", { name: "Actions for beta.cfg" }).click();
    await page.getByRole("menuitem", { name: "Permissions" }).click();
    const dlg = page.getByTestId("chmod-dialog");
    await expect(dlg).toBeVisible();
    const box = (await dlg.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });
});
