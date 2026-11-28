/**
 * Backups (voortgangsbalk, annuleren) en meldingen: bel/inbox, voorkeuren, admin-SMTP met een nep-SMTP
 * (testmail en bevestigingslink komen echt aan). Backups gaan naar een eigen S3 achter een trage proxy.
 */
import { execFileSync } from "node:child_process";
import { login, waitFor } from "../integration/helpers";
import { decodeQp, startFakeSmtp, startThrottle } from "./fakes";
import { adminSession, asAdmin, asUser, expect, startS3, test, USER } from "./support";
import { need, saveState } from "./state";

test.describe.configure({ mode: "serial" });

let s3Container = "";
let throttle: Awaited<ReturnType<typeof startThrottle>> | null = null;
let smtp: Awaited<ReturnType<typeof startFakeSmtp>> | null = null;

test.beforeAll(async () => {
  const admin = await adminSession();
  const s3 = startS3();
  s3Container = s3.container;
  saveState({ s3: s3.container });
  // ~2 MB/s naar de S3: een backup van 40 MB duurt dan ~20 s
  throttle = await startThrottle(Number(new URL(s3.endpoint).port), 2_000_000);
  const endpoint = `http://127.0.0.1:${throttle.port}`;
  const existing = (await admin.api.admin.s3Targets.list.query())[0];
  if (existing) await admin.api.admin.s3Targets.update.mutate({ id: existing.id, endpoint, bucket: s3.bucket, accessKey: s3.accessKey, secretKey: s3.secretKey, region: "us-east-1", pathStyle: true });
  else await admin.api.admin.s3Targets.create.mutate({ name: "qa-s3", endpoint, bucket: s3.bucket, region: "us-east-1", pathStyle: true, accessKey: s3.accessKey, secretKey: s3.secretKey });
  smtp = await startFakeSmtp();
});

test.afterAll(async () => {
  await throttle?.close();
  await smtp?.close();
  if (s3Container) try { execFileSync("docker", ["rm", "-f", s3Container]); } catch {}
});

test("notification prefs: turn on 'Backup completed' in the panel, persists", async ({ page, context }) => {
  await asUser(context);
  await page.goto("/account");
  const prefs = page.getByTestId("notification-prefs");
  const cb = prefs.getByRole("checkbox", { name: "Backup completed: Panel" });
  await expect(cb).toBeVisible();
  if (await cb.isChecked()) {
    await cb.uncheck();
    await expect(cb).not.toBeChecked();
    await expect(cb).toBeEnabled();
  }
  await cb.check();
  await expect(cb).toBeChecked();
  await expect(cb).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId("notification-prefs").getByRole("checkbox", { name: "Backup completed: Panel" })).toBeChecked();
});

test("bell: a completed backup lands in the inbox; mark all as read", async ({ page, context }) => {
  test.setTimeout(5 * 60_000);
  const uuid = need("paper");
  const api = (await login(USER.id, USER.name)).api;
  await api.inbox.markRead.mutate({});
  await asUser(context);
  await page.goto(`/servers/${uuid}/backups`);
  await page.getByLabel("Name", { exact: true }).fill("qa notify backup");
  await page.getByRole("button", { name: "Create backup" }).click();
  const row = page.getByTestId("backup-row").filter({ hasText: "qa notify backup" });
  await expect(row.getByText("Complete")).toBeVisible({ timeout: 3 * 60_000 });
  await waitFor("inbox item", async () => (await api.inbox.unreadCount.query()).count > 0, 60_000, 1000);
  await page.reload();
  const bell = page.getByTestId("notification-bell").locator("visible=true");
  await expect(bell.getByTestId("unread-count")).toBeVisible();
  await expect(bell).toHaveAttribute("aria-label", /Notifications \(\d+ unread\)/);
  await bell.click();
  const item = page.getByTestId("inbox-item").first();
  await expect(item).toBeVisible();
  await expect(item).toContainText(/backup/i);
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(bell.getByTestId("unread-count")).toHaveCount(0);
  await expect(bell).toHaveAttribute("aria-label", "Notifications");
});

test("backups: progress bar appears and the backup can be cancelled", async ({ page, context }) => {
  test.setTimeout(5 * 60_000);
  const uuid = need("paper");
  // 40 MB willekeurige data (comprimeert niet) in de servermap
  execFileSync("docker", ["exec", `panel-${uuid}`, "sh", "-c", "head -c 40000000 /dev/urandom > /home/container/qa-big.bin"]);
  await asUser(context);
  await page.goto(`/servers/${uuid}/backups`);
  await page.getByLabel("Name", { exact: true }).fill("qa slow backup");
  await page.getByRole("button", { name: "Create backup" }).click();
  const row = page.getByTestId("backup-row").filter({ hasText: "qa slow backup" });
  const bar = row.getByTestId("backup-progress");
  await expect(bar).toBeVisible({ timeout: 30_000 });
  await expect(bar.getByRole("progressbar")).toBeVisible();
  // de balk loopt op
  await expect.poll(async () => Number((await bar.getByRole("progressbar").getAttribute("aria-valuenow")) ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
  await bar.getByRole("button", { name: "Cancel" }).click();
  await expect(row.getByTestId("backup-error")).toHaveText("Cancelled", { timeout: 60_000 });
  await expect(bar).toHaveCount(0);
  execFileSync("docker", ["exec", `panel-${uuid}`, "rm", "-f", "/home/container/qa-big.bin"]);
});

// ---------------------------------------------------------------- SMTP

test("admin SMTP: save settings for a local fake SMTP and send a test mail", async ({ page, context }) => {
  await asAdmin(context);
  await page.goto("/admin/settings/email");
  const card = page.getByTestId("smtp-card");
  await expect(card).toBeVisible();
  await card.getByLabel("Host").fill("127.0.0.1");
  await card.getByLabel("Encryption").selectOption("none");
  await card.getByLabel("Port").fill(String(smtp!.port));
  await card.getByLabel("Sender address").fill("panel@panel.test");
  await card.getByLabel("Sender name").fill("QA Panel");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("SMTP settings saved.")).toBeVisible();
  await page.getByLabel("Send a test e-mail to").fill("qa-admin@panel.test");
  await page.getByRole("button", { name: "Send test e-mail" }).click();
  await expect(page.getByText("Test e-mail sent. Check the inbox.")).toBeVisible({ timeout: 30_000 });
  await waitFor("mail", async () => smtp!.mails.some((m) => m.to.join(",").includes("qa-admin@panel.test")), 20_000, 250);
  const mail = smtp!.mails.find((m) => m.to.join(",").includes("qa-admin@panel.test"))!;
  expect(mail.from).toContain("panel@panel.test");
  expect(mail.data).toMatch(/^From: "?QA Panel"? <panel@panel\.test>/m);
  await page.reload();
  await expect(page.getByTestId("smtp-card").getByLabel("Host")).toHaveValue("127.0.0.1");
});

test("account e-mail: confirmation link arrives and confirms the address; e-mail channel becomes available", async ({ page, context }) => {
  await asUser(context);
  await page.goto("/account");
  const card = page.getByTestId("email-card");
  await expect(card.getByText("E-mail is not set up on this panel yet.", { exact: false })).toHaveCount(0);
  const before = smtp!.mails.length;
  await card.getByLabel("E-mail address").fill("not-an-address");
  await expect(card.getByText("Not a valid e-mail address.")).toBeVisible();
  await card.getByLabel("E-mail address").fill("webbaas@panel.test");
  await card.getByRole("button", { name: "Send confirmation link" }).click();
  await expect(card.getByText(/Confirmation link sent/)).toBeVisible();
  await expect(card.getByText(/Waiting for confirmation of webbaas@panel\.test/)).toBeVisible();
  await waitFor("confirmation mail", async () => smtp!.mails.slice(before).some((m) => m.to.join(",").includes("webbaas@panel.test")), 60_000, 500);
  const mail = smtp!.mails.slice(before).find((m) => m.to.join(",").includes("webbaas@panel.test"))!;
  const link = decodeQp(mail.data).match(/https?:\/\/[^\s"'<>]+\/verify-email\?token=[A-Za-z0-9_%-]+/)?.[0];
  expect(link, "verify link in the mail").toBeTruthy();
  await page.goto(link!.replace(/^https?:\/\/[^/]+/, ""));
  await expect(page.getByText("webbaas@panel.test is confirmed.", { exact: false })).toBeVisible();
  await page.goto("/account");
  await expect(page.getByTestId("email-card").getByText("Notifications go to webbaas@panel.test.")).toBeVisible();
  await expect(page.getByTestId("notification-prefs").getByText("No confirmed e-mail address")).toHaveCount(0);
});
