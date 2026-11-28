/**
 * Filemanager (zoeken, chmod, map als zip, verplaatsen), statistieken + sparkline, Monaco zonder externe requests.
 * Draait op de sleeper-gameserver van 01 (die loopt al minuten, dus er zijn metingen).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { login, waitFor } from "../integration/helpers";
import { adminSession, asUser, expect, test, USER } from "./support";
import { need } from "./state";

test.describe.configure({ mode: "serial" });
const files = () => `/servers/${need("game")}/files`;
const userApi = async () => (await login(USER.id, USER.name)).api;

test.beforeAll(async () => {
  const api = await userApi();
  const uuid = need("game");
  await api.files.delete.mutate({ uuid, paths: ["/qa-dir", "/qa-dest"] }).catch(() => {});
  await api.files.mkdir.mutate({ uuid, path: "/qa-dir/sub" });
  await api.files.mkdir.mutate({ uuid, path: "/qa-dest" });
  await api.files.write.mutate({ uuid, path: "/qa-dir/alpha.txt", content: "first line\nthe needle-xyz-42 is here\n" });
  await api.files.write.mutate({ uuid, path: "/qa-dir/sub/beta.cfg", content: "nothing to see\n" });
  const admin = await adminSession();
  await admin.api.servers.power.mutate({ uuid, action: "start" }).catch(() => {});
});

test("files: search by name and by content", async ({ page, context }) => {
  await asUser(context);
  await page.goto(files());
  const form = page.getByTestId("file-search-form");
  await form.getByRole("searchbox", { name: "Search" }).fill("beta*");
  await form.getByRole("button", { name: "Search" }).click();
  const results = page.getByTestId("file-search-results");
  await expect(results.getByTestId("search-hit")).toHaveCount(1);
  await expect(results.getByTestId("search-hit")).toContainText("/qa-dir/sub/beta.cfg");
  // inhoud: de regel met de treffer staat erbij
  await form.getByLabel("Search file contents").check();
  await form.getByRole("searchbox", { name: "Search" }).fill("needle-xyz");
  await form.getByRole("button", { name: "Search" }).click();
  const hit = results.getByTestId("search-hit").filter({ hasText: "/qa-dir/alpha.txt" });
  await expect(hit).toBeVisible();
  await expect(hit).toContainText("line 2");
  await expect(hit).toContainText("the needle-xyz-42 is here");
  // niets gevonden
  await form.getByRole("searchbox", { name: "Search" }).fill("zz-no-such-text-zz");
  await form.getByRole("button", { name: "Search" }).click();
  await expect(results.getByText("Nothing found.")).toBeVisible();
  await results.getByRole("button", { name: "Close search" }).click();
  await expect(results).toHaveCount(0);
});

test("files: chmod dialog sets the mode (and refuses invalid octal)", async ({ page, context }) => {
  await asUser(context);
  await page.goto(files());
  await page.getByRole("button", { name: "qa-dir", exact: true }).click();
  await page.getByRole("button", { name: "Actions for alpha.txt" }).click();
  await page.getByRole("menuitem", { name: "Permissions" }).click();
  const dlg = page.getByTestId("chmod-dialog");
  await expect(dlg).toContainText("Permissions of alpha.txt");
  const octal = dlg.getByLabel("Octal", { exact: true });
  // niet-octale tekens worden weggefilterd; te kort = Apply uit
  await octal.fill("98");
  await expect(octal).toHaveValue("");
  await expect(dlg.getByRole("button", { name: "Apply" })).toBeDisabled();
  await octal.fill("64");
  await expect(dlg.getByRole("button", { name: "Apply" })).toBeDisabled();
  await octal.fill("640");
  await expect(dlg.getByTestId("file-mode-string")).toContainText("rw-r-----");
  // checkboxes en octaal lopen gelijk
  await expect(dlg.getByRole("checkbox", { name: "Group write" })).not.toBeChecked();
  await expect(dlg.getByRole("checkbox", { name: "Group read" })).toBeChecked();
  await dlg.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Permissions set on 1 item.")).toBeVisible();
  const api = await userApi();
  const e = (await api.files.list.query({ uuid: need("game"), path: "/qa-dir" })).find((x) => x.name === "alpha.txt")!;
  expect(e.mode).toBe("-rw-r-----");
});

test("files: download a folder as .zip (download event, zip contents)", async ({ page, context }) => {
  await asUser(context);
  await page.goto(files());
  await page.getByRole("button", { name: "qa-dir", exact: true }).click();
  await expect(page.getByTestId("file-row").filter({ hasText: "alpha.txt" })).toBeVisible();
  await page.getByRole("button", { name: "Download folder" }).click();
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("menuitem", { name: "Download as .zip" }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const dir = mkdtempSync(join(process.env.IT_WORK ?? "/tmp", "zip-"));
  const file = join(dir, "dl.zip");
  await download.saveAs(file);
  const script = join(mkdtempSync(join(process.env.IT_WORK ?? "/tmp", "py-")), "ls.py");
  writeFileSync(script, "import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nfor n in z.namelist(): print(n)\nprint('ALPHA=' + z.read([n for n in z.namelist() if n.endswith('alpha.txt')][0]).decode().splitlines()[1])\n");
  const out = execFileSync("python3", ["-I", script, file]).toString();
  expect(out).toMatch(/^qa-dir\/alpha\.txt$/m);
  expect(out).toMatch(/^qa-dir\/sub\/beta\.cfg$/m);
  expect(out).toContain("ALPHA=the needle-xyz-42 is here");
});

test("files: move a selected file to another folder", async ({ page, context }) => {
  await asUser(context);
  await page.goto(files());
  await page.getByRole("button", { name: "qa-dir", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select alpha.txt" }).check();
  await page.getByTestId("selection-bar").getByRole("button", { name: "Move" }).click();
  const prompt = page.getByTestId("move-prompt");
  const dest = prompt.getByRole("textbox", { name: "Destination folder (e.g. /plugins)" });
  await dest.fill("qa-dest");
  await prompt.getByRole("button", { name: /^Move/ }).click();
  await expect(prompt.getByText("Enter a folder starting with /")).toBeVisible();
  // Annuleren verplaatst niets
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByTestId("file-row").filter({ hasText: "alpha.txt" })).toBeVisible();
  await page.getByTestId("selection-bar").getByRole("button", { name: "Move" }).click();
  await prompt.getByRole("textbox").fill("/qa-dest");
  await prompt.getByRole("button", { name: /^Move/ }).click();
  await expect(page.getByText("Moved 1 item.")).toBeVisible();
  await expect(page.getByTestId("file-row").filter({ hasText: "alpha.txt" })).toHaveCount(0);
  const api = await userApi();
  const moved = await api.files.list.query({ uuid: need("game"), path: "/qa-dest" });
  expect(moved.map((e) => e.name)).toContain("alpha.txt");
});

test("monaco editor loads without requests to other origins (CSP)", async ({ page, context, consoleErrors }) => {
  await asUser(context);
  const foreign: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return;
    if (u.hostname !== "localhost" && u.hostname !== process.env.NODE_DOMAIN) foreign.push(r.url().slice(0, 150));
  });
  await page.goto(files());
  await page.getByRole("button", { name: "qa-dir", exact: true }).click();
  await page.getByRole("button", { name: "sub", exact: true }).click();
  await page.getByRole("button", { name: "Actions for beta.cfg" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editor = page.getByTestId("file-editor");
  await expect(editor.locator(".monaco-editor")).toBeVisible({ timeout: 60_000 });
  await expect(editor.locator(".view-lines")).toContainText("nothing to see", { timeout: 30_000 });
  // een paar tekens typen: workers/tokenizer worden dan echt gebruikt
  await editor.locator(".monaco-editor").click();
  await page.keyboard.type("x");
  await expect(editor.getByText("unsaved")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(foreign, "requests to other origins").toEqual([]);
  expect(consoleErrors.filter((e) => /Content Security Policy|Refused to/i.test(e)), "CSP violations").toEqual([]);
});

// ---------------------------------------------------------------- statistieken

test("statistics tab: charts render and the range can be switched", async ({ page, context }) => {
  test.setTimeout(5 * 60_000);
  const uuid = need("game");
  const api = await userApi();
  // minstens twee metingen (elke minuut); de sleeper draait sinds 01
  await waitFor("two samples", async () => ((await api.servers.statsHistory.query({ uuid, range: "1h" })).points.filter((p) => p.cpuPct !== null).length >= 2), 3 * 60_000, 5000);
  await asUser(context);
  await page.goto(`/servers/${uuid}`);
  await page.getByRole("navigation", { name: "Server sections" }).getByRole("link", { name: "Statistics" }).click();
  await expect(page).toHaveURL(/\/stats$/);
  const view = page.getByTestId("stats-view");
  await expect(view).toBeVisible();
  const range = view.getByTestId("stats-range");
  // standaard 24 uur
  await expect(range.getByRole("button", { name: "24 hours" })).toHaveAttribute("aria-pressed", "true");
  await expect(view.getByTestId("chart-card")).toHaveCount(4);
  await expect(view.getByTestId("usage-chart").first()).toBeVisible();
  await expect(view.getByTestId("usage-chart").first().locator("path").first()).toBeAttached();
  await range.getByRole("button", { name: "1 hour" }).click();
  await expect(range.getByRole("button", { name: "1 hour" })).toHaveAttribute("aria-pressed", "true");
  await expect(range.getByRole("button", { name: "24 hours" })).toHaveAttribute("aria-pressed", "false");
  await expect(view.getByTestId("chart-card")).toHaveCount(4);
  await expect(view.getByTestId("usage-chart").first().locator("path").first()).toBeAttached();
  await range.getByRole("button", { name: "30 days" }).click();
  await expect(range.getByRole("button", { name: "30 days" })).toHaveAttribute("aria-pressed", "true");
  await expect(view.getByTestId("stats-empty").or(view.getByTestId("chart-card").first())).toBeVisible();
  // de keuze wordt onthouden (localStorage panel_stats_range)
  await page.reload();
  await expect(view.getByTestId("stats-range").getByRole("button", { name: "30 days" })).toHaveAttribute("aria-pressed", "true");
  await view.getByTestId("stats-range").getByRole("button", { name: "24 hours" }).click();
});

test("overview card shows a CPU sparkline for a running server", async ({ page, context }) => {
  await asUser(context);
  await page.goto("/");
  const card = page.getByTestId("server-card").filter({ hasText: "E2E sleeper" });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("card-sparkline")).toBeVisible({ timeout: 90_000 });
  await expect(card.getByTestId("sparkline")).toHaveAttribute("aria-label", "CPU, last hour");
});
