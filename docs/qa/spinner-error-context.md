# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 06-ui.spec.ts >> loading spinner has an English accessible name for English users
- Location: 06-ui.spec.ts:162:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('status', { name: 'Loading…' })
Expected: visible
Timeout: 30000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('status', { name: 'Loading…' }) with timeout 30000ms
  - waiting for getByRole('status', { name: 'Loading…' })

```

```yaml
- alert
- complementary:
  - link "Go to overview":
    - /url: /
    - text: E2E Panel
  - navigation "Menu":
    - group "Panel":
      - text: Panel
      - list:
        - listitem:
          - link "My servers":
            - /url: /
  - button "Switch to light theme"
  - group "Language":
    - button "en" [pressed]
    - button "nl"
  - button "User menu": webbaas
- banner:
  - button "Collapse sidebar" [expanded]
  - navigation "Breadcrumb":
    - list:
      - listitem: My servers
- main:
  - heading "My servers" [level=1]
  - paragraph: 4 servers · 4 online
  - link "E2E paper":
    - /url: /servers/ff05b031-4d55-4134-be82-cb15f8a9a185
  - paragraph: Paper · node1
  - text: Online
  - code: 127.0.0.1:39033
  - button "Copy address"
  - text: CPU 0% / 100%
  - progressbar "CPU"
  - text: Memory 384 KiB / 256 MiB
  - progressbar "Memory"
  - text: Disk 19 B / 1 GiB
  - progressbar "Disk"
  - link "E2E site":
    - /url: /servers/701546d4-6819-499d-9541-852e2342120a
  - paragraph: PHP 8.3 (nginx + PHP-FPM) · node1
  - text: Online No address CPU 0.1% / 200%
  - progressbar "CPU"
  - text: Memory 5.6 MiB / 512 MiB
  - progressbar "Memory"
  - text: Disk 46.6 MiB / 2 GiB
  - progressbar "Disk"
  - link "E2E sleeper":
    - /url: /servers/9bc849f2-6d99-4cd7-802b-a91a3ebeedbd
  - paragraph: IT sleeper (alleen integratietest) · node1
  - text: Online
  - code: 127.0.0.1:53065
  - button "Copy address"
  - text: CPU 0% / 200%
  - progressbar "CPU"
  - text: Memory 472 KiB / 256 MiB
  - progressbar "Memory"
  - text: Disk 6 B / 512 MiB
  - progressbar "Disk"
  - link "E2E velocity":
    - /url: /servers/2f457ae6-2f6f-4093-936f-9a5bc808ded7
  - paragraph: Velocity · node1
  - text: Online
  - code: 127.0.0.1:41587
  - button "Copy address"
  - text: CPU 0% / 100%
  - progressbar "CPU"
  - text: Memory 380 KiB / 256 MiB
  - progressbar "Memory"
  - text: Disk 179 B / 1 GiB
  - progressbar "Disk"
```

# Test source

```ts
  66  | 
  67  | test("sidebar: keyboard navigation, collapse state persists, aria-current", async ({ page, context }) => {
  68  |   await asAdmin(context);
  69  |   await page.goto("/admin");
  70  |   const sb = page.getByTestId("sidebar");
  71  |   await expect(sb).toBeVisible();
  72  |   await expect(sb.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  73  |   // Tab reaches the sidebar links in order and Enter follows
  74  |   await sb.getByRole("link", { name: "Servers", exact: true }).focus();
  75  |   await page.keyboard.press("Tab");
  76  |   await expect(sb.getByRole("link", { name: "Nodes" })).toBeFocused();
  77  |   await page.keyboard.press("Tab");
  78  |   await page.keyboard.press("Enter");
  79  |   await expect(page).toHaveURL(/\/admin\/users/);
  80  |   await expect(page.getByTestId("sidebar").getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
  81  |   // settings has sub navigation
  82  |   await page.getByTestId("sidebar").getByRole("link", { name: "Settings", exact: true }).click();
  83  |   await expect(page.getByTestId("nav-subitems")).toBeVisible();
  84  |   await page.getByTestId("nav-subitems").getByRole("link", { name: "Backup storage" }).click();
  85  |   await expect(page).toHaveURL(/backup-storage/);
  86  |   // collapse, reload: stays collapsed; links keep an accessible name
  87  |   await page.getByTestId("sidebar-toggle").click();
  88  |   await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
  89  |   await page.reload();
  90  |   await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
  91  |   await expect(page.getByTestId("sidebar").getByRole("link", { name: "Users" })).toBeVisible();
  92  |   await page.getByTestId("sidebar-toggle").click();
  93  |   await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "false");
  94  | });
  95  | 
  96  | test("light theme: applies, persists after reload and text is readable", async ({ page, context }) => {
  97  |   await asUser(context);
  98  |   await page.goto("/");
  99  |   await page.getByTestId("sidebar").getByTestId("theme-toggle").click();
  100 |   await expect(page.locator("html")).toHaveClass(/light/);
  101 |   await page.reload();
  102 |   await expect(page.locator("html")).toHaveClass(/light/);
  103 |   // computed colors can be lab()/oklch(): let a canvas convert them to sRGB
  104 |   const lum = await page.evaluate(() => {
  105 |     const px = (c: string) => { const x = document.createElement("canvas").getContext("2d")!; x.fillStyle = c; x.fillRect(0, 0, 1, 1); const [r, g, b] = x.getImageData(0, 0, 1, 1).data; return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
  106 |     const bgC = [document.body, document.documentElement].map((e) => getComputedStyle(e).backgroundColor).find((c) => !/, 0\)$|transparent/.test(c)) ?? "rgb(0,0,0)";
  107 |     return { bg: px(bgC), fg: px(getComputedStyle(document.body).color) };
  108 |   });
  109 |   expect(lum.bg).toBeGreaterThan(180);
  110 |   expect(lum.fg).toBeLessThan(100);
  111 |   await page.screenshot({ path: `test-results/qa-light-home.png` });
  112 |   await page.getByTestId("sidebar").getByTestId("theme-toggle").click();
  113 |   await expect(page.locator("html")).toHaveClass(/dark/);
  114 | });
  115 | 
  116 | test("language switch NL: navigation, server tabs and settings are translated", async ({ page, context }) => {
  117 |   await asUser(context);
  118 |   await page.goto(`/servers/${need("site")}`);
  119 |   await page.getByTestId("sidebar").getByTestId("user-menu").click();
  120 |   await page.getByTestId("locale-nl").click();
  121 |   await expect(page.getByRole("link", { name: "Mijn servers" }).first()).toBeVisible();
  122 |   await page.goto(`/servers/${need("site")}/settings`);
  123 |   await expect(page.getByTestId("php-settings-card")).toBeVisible();
  124 |   const txt = await page.locator("main").innerText();
  125 |   expect(txt, "English strings left in the Dutch settings page").not.toMatch(/Maximum upload size|Image updates|Save and restart/);
  126 |   await page.getByTestId("sidebar").getByTestId("user-menu").click();
  127 |   await page.getByTestId("locale-en").click();
  128 | });
  129 | 
  130 | test("console reconnects after the daemon restarts", async ({ page, context }) => {
  131 |   test.setTimeout(4 * 60_000);
  132 |   const admin = await adminSession();
  133 |   await admin.api.servers.power.mutate({ uuid: need("game"), action: "start" }).catch(() => {});
  134 |   await asUser(context);
  135 |   await page.goto(`/servers/${need("game")}`);
  136 |   const state = page.getByTestId("console-state");
  137 |   await expect(state).toHaveAttribute("data-state", "connected", { timeout: 60_000 });
  138 |   await restartDaemon(3000);
  139 |   await expect(state).toHaveAttribute("data-state", "connected", { timeout: 90_000 });
  140 |   await page.getByTestId("console-input").fill("echo after-restart-77");
  141 |   await page.getByTestId("console-input").press("Enter");
  142 |   await expect(page.locator(".xterm")).toContainText("after-restart-77", { timeout: 30_000 });
  143 |   await waitFor("server still online", async () => (await admin.api.servers.get.query({ uuid: need("game") })).status === "online", 60_000);
  144 | });
  145 | 
  146 | test("no console errors on any main page (user and admin)", async ({ page, context, consoleErrors }) => {
  147 |   test.setTimeout(6 * 60_000);
  148 |   await asAdmin(context);
  149 |   const seen: string[] = [];
  150 |   const all = [...userPages(), ...adminPages, `/servers/${need("paper")}`, `/servers/${need("paper")}/content`, `/servers/${need("velocity")}/network`, `/servers/${need("paper")}/bedrock`];
  151 |   for (const p of all) {
  152 |     consoleErrors.length = 0;
  153 |     await page.goto(p, { waitUntil: "load" });
  154 |     await page.waitForLoadState("networkidle").catch(() => {});
  155 |     await page.waitForTimeout(500);
  156 |     for (const e of consoleErrors) seen.push(`${p}: ${e.slice(0, 200)}`);
  157 |   }
  158 |   expect(seen, "console.error output").toEqual([]);
  159 | });
  160 | 
  161 | // BUG (docs/qa-report.md #2): Spinner defaults to the Dutch label "Laden…" (ui/spinner.tsx:4), also for English users.
  162 | test("loading spinner has an English accessible name for English users", async ({ page, context }) => {
  163 |   await asUser(context);
  164 |   await page.route("**/api/trpc/**auth.me**", async (route) => { await new Promise((r) => setTimeout(r, 4000)); await route.continue(); });
  165 |   await page.goto("/");
> 166 |   await expect(page.getByRole("status", { name: "Loading…" })).toBeVisible();
      |                                                                ^ Error: expect(locator).toBeVisible() failed
  167 |   await expect(page.getByRole("status", { name: "Laden…" })).toHaveCount(0);
  168 | });
  169 | 
```