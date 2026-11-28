/**
 * Openbare statuspagina (aanzetten in de serverinstellingen, zonder login bereikbaar, geen IP/uuid) en
 * pakketten (admin maakt een gratis pakket, gebruiker maakt zelf een server; facturatie blijft uit).
 */
import { login } from "../integration/helpers";
import { adminSession, asAdmin, asUser, expect, freePorts, test } from "./support";
import { need } from "./state";

test.describe.configure({ mode: "serial" });

const SLUG = "qa-paper-status";
const PLAN_USER = { id: "200000000000000030", name: "pakketje" };

test("status page: turn on in server settings, public without login, no IP or uuid", async ({ page, context, browser }) => {
  const uuid = need("paper");
  await asUser(context);
  await page.goto(`/servers/${uuid}/settings`);
  const card = page.getByTestId("status-page-card");
  await expect(card).toBeVisible();
  await card.getByRole("switch", { name: "Status page on" }).check();
  await card.getByLabel("Address", { exact: true }).fill("Bad Slug!");
  await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
  await card.getByLabel("Address", { exact: true }).fill(SLUG);
  await expect(card.getByText(`/status/${SLUG}`)).toBeVisible();
  await expect(card.getByRole("checkbox", { name: /Show the server address/ })).not.toBeChecked();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("Saved.")).toBeVisible();
  await expect(card.getByRole("link", { name: "Open page" })).toHaveAttribute("href", `/status/${SLUG}`);

  // zonder login (nieuwe context zonder cookies)
  const anon = await browser.newContext();
  const p = await anon.newPage();
  const res = await p.goto(`/status/${SLUG}`);
  expect(res?.status()).toBeLessThan(400);
  await expect(p).toHaveURL(new RegExp(`/status/${SLUG}$`));
  await expect(p.getByRole("heading", { level: 1, name: "E2E paper" })).toBeVisible();
  await expect(p.getByTestId("public-server")).toHaveCount(1);
  await expect(p.getByTestId("overall")).toBeVisible();
  await p.waitForLoadState("networkidle").catch(() => {});
  const html = await p.content();
  const text = await p.locator("body").innerText();
  for (const leak of [uuid, uuid.slice(0, 8), "127.0.0.1"]) {
    expect(html, `status page leaks ${leak}`).not.toContain(leak);
  }
  expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/);
  // het tRPC-antwoord zelf bevat ook geen adres
  const api = await p.request.get(`/api/trpc/statusPages.public?input=${encodeURIComponent(JSON.stringify({ json: { slug: SLUG } }))}`);
  const body = await api.text();
  expect(body).not.toContain(uuid);
  expect(body).not.toContain("127.0.0.1");
  await anon.close();

  // uitzetten: pagina is weg
  await page.reload();
  await page.getByTestId("status-page-card").getByRole("switch", { name: "Status page on" }).uncheck();
  await page.getByTestId("status-page-card").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("status-page-card").getByText("Saved.")).toBeVisible();
  const anon2 = await browser.newContext();
  const p2 = await anon2.newPage();
  await p2.goto(`/status/${SLUG}`);
  await expect(p2.getByText("This status page does not exist or is turned off.")).toBeVisible();
  await anon2.close();
});

// ---------------------------------------------------------------- pakketten

test("admin turns plans + free self-service on, billing stays off", async ({ page, context }) => {
  await asAdmin(context);
  await page.goto("/admin/settings/billing");
  const form = page.getByTestId("billing-settings");
  await expect(form).toBeVisible();
  await form.getByRole("checkbox", { name: "Plans enabled" }).check();
  await form.getByRole("checkbox", { name: "Users may pick free plans themselves" }).check();
  await expect(form.getByRole("checkbox", { name: "Billing enabled" })).not.toBeChecked();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("billing-settings").getByRole("checkbox", { name: "Plans enabled" })).toBeChecked();
  await expect(page.getByTestId("billing-settings").getByRole("checkbox", { name: "Users may pick free plans themselves" })).toBeChecked();
  await expect(page.getByTestId("billing-settings").getByRole("checkbox", { name: "Billing enabled" })).not.toBeChecked();
});

test("admin creates a free game plan", async ({ page, context }) => {
  const admin = await adminSession();
  const node = (await admin.api.admin.nodes.list.query()).find((n) => n.isLocal)!;
  const [port] = await freePorts(1);
  await admin.api.admin.allocations.create.mutate({ nodeId: node.id, ip: "127.0.0.1", ports: String(port) });
  await asAdmin(context);
  await page.goto("/admin/plans");
  await page.getByRole("button", { name: "New plan" }).click();
  const form = page.getByTestId("plan-form");
  await form.getByLabel("Name", { exact: true }).fill("QA small");
  await form.getByLabel("Type").selectOption("game");
  await form.getByRole("checkbox", { name: "IT sleeper (alleen integratietest)" }).check();
  await form.getByLabel("Memory (MB)").fill("256");
  await form.getByLabel("CPU (%)").fill("50");
  await form.getByLabel("Disk (MB)").fill("512");
  await form.getByLabel("Ports").fill("1");
  await form.getByLabel("Price per month").fill("0");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("admin-plan").filter({ hasText: "QA small" })).toBeVisible();
});

test("user creates their own server from the free plan; no payment involved", async ({ page, context }) => {
  test.setTimeout(4 * 60_000);
  await asUser(context, PLAN_USER.id, PLAN_USER.name);
  await page.goto("/plans");
  const plan = page.getByTestId("plan-card").filter({ hasText: "QA small" });
  await expect(plan).toBeVisible();
  await expect(plan.getByTestId("plan-price")).toHaveText("Free");
  await plan.getByRole("button", { name: "Choose" }).click();
  await expect(page.getByText("Plan: QA small")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Plan sleeper");
  await expect(page.getByRole("button", { name: "Continue to payment" })).toHaveCount(0);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Plan sleeper" })).toBeVisible();
  const uuid = page.url().match(/servers\/([0-9a-f-]{36})/)![1]!;
  const api = (await login(PLAN_USER.id, PLAN_USER.name)).api;
  const s = await api.servers.get.query({ uuid });
  expect(s.limits.ramMb).toBe(256);
  expect(s.limits.diskMb).toBe(512);
  expect(s.limits.cpuPct).toBe(50);
  // geen facturen, geen betaal-URL
  const admin = await adminSession();
  const st = await admin.api.admin.billing.get.query();
  expect(st.billingEnabled).toBe(false);
  await page.goto("/billing");
  await expect(page.getByText("No invoices yet.")).toBeVisible();
});
