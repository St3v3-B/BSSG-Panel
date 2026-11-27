import { asUser, expect, test } from "./support";
import { need } from "./state";
import { writeFileSync } from "node:fs";
import { env } from "../integration/helpers";

test.describe.configure({ mode: "serial" });
const url = (tab = "") => `/servers/${need("site")}${tab}`;

test("Logs tab shows install output and has no input line", async ({ page, context }) => {
  await asUser(context);
  await page.goto(url());
  await page.getByRole("tab", { name: "Logs" }).or(page.getByRole("link", { name: "Logs" })).first().click();
  await expect(page.getByTestId("log-viewer")).toBeVisible();
  await expect(page.getByTestId("console-input")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Command" })).toHaveCount(0);
});

test("Files: create, edit and save a file; upload a file", async ({ page, context }) => {
  await asUser(context);
  await page.goto(url("/files"));
  await page.getByRole("button", { name: "public", exact: true }).click();
  await page.getByRole("button", { name: "New file" }).click();
  await page.getByLabel("Name of the new file").fill("hello.php");
  await page.getByTestId("name-prompt").getByRole("button").first().click();
  // Een nieuw bestand opent meteen in de editor.
  const editor = page.getByTestId("file-editor");
  await expect(editor).toBeVisible();
  await expect(editor.locator(".monaco-editor")).toBeVisible({ timeout: 60_000 });
  await editor.locator(".monaco-editor").click();
  await page.keyboard.type("<?php echo 'e2e-ok';");
  await expect(editor.getByText("unsaved")).toBeVisible();
  await page.getByTestId("file-save").click();
  await expect(editor.getByText("saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to folder" }).click();
  // Opnieuw openen via het actiemenu toont de opgeslagen inhoud.
  await page.getByRole("button", { name: "Actions for hello.php" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(editor.locator(".view-lines")).toContainText("e2e-ok", { timeout: 30_000 });
  await page.getByRole("button", { name: "Back to folder" }).click();

  const f = `${env("IT_WORK")}/upload-me.txt`;
  writeFileSync(f, "uploaded by e2e");
  await page.getByTestId("upload-input").setInputFiles(f);
  await expect(page.getByTestId("file-row").filter({ hasText: "upload-me.txt" })).toBeVisible({ timeout: 30_000 });
});

test("Domains: add site1.test", async ({ page, context }) => {
  await asUser(context);
  await page.goto(url("/domains"));
  await page.getByLabel("Domain", { exact: true }).fill("site1.test");
  await page.getByTestId("add-domain-form").getByRole("button", { name: /Add|Connect/ }).click();
  await expect(page.getByTestId("domain-card").filter({ hasText: "site1.test" }).first()).toBeVisible();
});

test("Databases: create one and reveal the password", async ({ page, context }) => {
  await asUser(context);
  await page.goto(url("/databases"));
  await page.getByLabel("Name", { exact: true }).fill("wp");
  await page.getByRole("button", { name: "Create" }).click();
  const card = page.getByTestId("database-card").first();
  await expect(card).toBeVisible();
  const masked = card.getByText("••••");
  const before = await masked.count();
  expect(before).toBeGreaterThan(0);
  await card.getByRole("button", { name: "Show" }).first().click();
  await expect(masked).toHaveCount(before - 1);
});

test("Settings: rename and reinstall dialog", async ({ page, context }) => {
  const newName = `E2E site renamed ${Date.now() % 100000}`;
  await asUser(context);
  await page.goto(url("/settings"));
  await page.getByLabel("Server name").fill(newName);
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByRole("heading", { name: newName })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Server name")).toHaveValue(newName);
  await page.getByTestId("reinstall-card").getByRole("button", { name: "Reinstall" }).click();
  const dlg = page.getByRole("alertdialog");
  await expect(dlg).toContainText(`Reinstall ${newName}?`);
  await expect(dlg.getByRole("button", { name: "Yes, reinstall" })).toBeVisible();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
});

// BUG: na het opslaan van de naam verschijnt "Name saved." niet (de rename lukt wel: kop en reload tonen de nieuwe naam).
test.fixme("Settings: renaming shows the 'Name saved.' confirmation", async ({ page, context }) => {
  await asUser(context);
  await page.goto(url("/settings"));
  await page.getByLabel("Server name").fill(`E2E rename ${Date.now() % 100000}`);
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Name saved.")).toBeVisible();
});
