/** Hulpmiddelen voor de browsertests. Hergebruikt de API-helpers van de integratietest. */
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { adminLogin, client, env, login, waitFor } from "../integration/helpers";

export { expect };
export const USER = { id: "200000000000000010", name: "webbaas" };

const DAEMON_HTTP = () => env("IT_DAEMON_URL");
const NODE = () => env("NODE_DOMAIN");

/**
 * De browser kan `wss://node1.test` / `https://node1.test` niet bereiken (dat is Caddy in
 * productie). We leiden die verzoeken naar de echte daemon op 127.0.0.1; de daemon blijft echt.
 */
export async function routeDaemon(page: Page) {
  await page.routeWebSocket(new RegExp(`^wss?://${NODE()}/`), (ws) => {
    const url = ws.url().replace(/^wss?:\/\/[^/]+/, DAEMON_HTTP().replace(/^http/, "ws"));
    const up = new WebSocket(url);
    const queue: Array<string | Buffer> = [];
    up.addEventListener("open", () => queue.splice(0).forEach((m) => up.send(m)));
    up.addEventListener("message", (e) => ws.send(typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer)));
    // Daemon onbereikbaar (bv. herstart): een mislukte handshake geeft alleen "error"; de pagina moet dan een close zien.
    up.addEventListener("error", () => ws.close({ code: 1011, reason: "upstream unreachable" }));
    up.addEventListener("close", (e) => ws.close({ code: e.code === 1005 ? 1000 : [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011].includes(e.code) || (e.code >= 3000 && e.code <= 4999) ? e.code : 1011, reason: e.reason }));
    ws.onMessage((m) => (up.readyState === WebSocket.OPEN ? up.send(m) : queue.push(m)));
    ws.onClose(() => up.close());
  });
  await page.route(new RegExp(`^https?://${NODE()}/`), async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": req.headers()["origin"] ?? "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const res = await fetch(req.url().replace(/^https?:\/\/[^/]+/, DAEMON_HTTP()), {
      method: req.method(),
      headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !["host", "origin", "referer", "content-length"].includes(k))),
      body: req.postDataBuffer() ? new Uint8Array(req.postDataBuffer()!) : undefined,
    });
    const headers: Record<string, string> = { ...cors };
    res.headers.forEach((v, k) => { if (!["content-encoding", "transfer-encoding", "content-length"].includes(k)) headers[k] = v; });
    await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
  });
}

/** Zet de sessiecookie (uit de test-login) in de browsercontext. */
export async function setSession(context: BrowserContext, cookie: string) {
  const base = new URL(env("IT_PANEL_URL").replace("127.0.0.1", "localhost"));
  const cookies = cookie.split("; ").map((c) => {
    const i = c.indexOf("=");
    return { name: c.slice(0, i), value: c.slice(i + 1), url: base.origin };
  });
  await context.addCookies(cookies);
}

export async function asUser(context: BrowserContext, discordId = USER.id, name = USER.name) {
  const s = await login(discordId, name);
  await setSession(context, s.cookie);
  return s;
}

/**
 * Admin-sessie, één keer geverifieerd en daarna hergebruikt: een TOTP-code mag maar één keer
 * gebruikt worden en te veel pogingen geven TOO_MANY_ATTEMPTS, dus niet elke test opnieuw inloggen.
 */
export async function adminSession() {
  const f = `${env("IT_WORK")}/admin-cookie`;
  if (existsSync(f)) {
    const cookie = readFileSync(f, "utf8");
    const api = client({ cookie });
    const me = await api.auth.me.query().catch(() => null);
    if (me?.isAdmin && me.totpVerified) return { cookie, api };
  }
  const s = await adminLogin();
  writeFileSync(f, s.cookie);
  return s;
}

/** Admin: eigenaar met 2FA, in dezelfde sessie geverifieerd. */
export async function asAdmin(context: BrowserContext) {
  const s = await adminSession();
  await setSession(context, s.cookie);
  return s;
}

/** Console-errors die geen applicatiefout zijn (bv. een bewust gestopte daemon in een reconnect-test). */
export const IGNORED_CONSOLE = [/WebSocket connection to/, /Failed to load resource/, /net::ERR_/];

export const test = base.extend<{ page: Page; pageErrors: string[]; consoleErrors: string[] }>({
  pageErrors: [async ({}, use) => { await use([]); }, { auto: false }],
  consoleErrors: [async ({}, use) => { await use([]); }, { auto: false }],
  page: async ({ page, pageErrors, consoleErrors }, use, info) => {
    const base0 = new URL(env("IT_PANEL_URL").replace("127.0.0.1", "localhost")).origin;
    // Elke onverwachte exception in de pagina laat de test falen.
    page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !IGNORED_CONSOLE.some((r) => r.test(m.text()))) consoleErrors.push(m.text());
    });
    const failed: string[] = [];
    page.on("requestfailed", (r) => failed.push(`${r.method()} ${r.url().slice(0, 150)} ${r.failure()?.errorText}`));
    page.on("response", (r) => { if (r.status() >= 400 && r.url().startsWith(base0)) failed.push(`${r.status()} ${r.url().slice(0, 150)}`); });
    await routeDaemon(page);
    await use(page);
    if (failed.length || consoleErrors.length || pageErrors.length) await info.attach("browser-problems.txt", { body: JSON.stringify({ failed, consoleErrors, pageErrors }, null, 1) });
    expect(pageErrors, "uncaught exceptions in the page").toEqual([]);
  },
});

// ---------- hulpmiddelen voor de feature-specs ----------
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { createWriteStream } from "node:fs";

export async function freePorts(n: number): Promise<number[]> {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise<ReturnType<typeof createServer>>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => res(s)); })));
  const ports = servers.map((s) => (s.address() as { port: number }).port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

/** Eigen S3 (rclone serve s3) met label panel.test + run-instance; ruimt run.sh op via het instance-label. */
export function startS3(): { endpoint: string; bucket: string; accessKey: string; secretKey: string; container: string } {
  const instance = env("PANEL_INSTANCE");
  const container = `qa-s3-${process.pid}-${Date.now() % 100000}`;
  execFileSync("docker", ["run", "-d", "--name", container, "--label", "panel.test=true", "--label", `panel.instance=${instance}`, "-p", "127.0.0.1::9000", "rclone/rclone:latest", "serve", "s3", "/data", "--addr", ":9000", "--auth-key", "AKQA,SKQA-secret-1"]);
  execFileSync("docker", ["exec", container, "mkdir", "-p", "/data/backups"]);
  const port = execFileSync("docker", ["port", container, "9000/tcp"]).toString().split("\n")[0]!.split(":").pop()!.trim();
  return { endpoint: `http://127.0.0.1:${port}`, bucket: "backups", accessKey: "AKQA", secretKey: "SKQA-secret-1", container };
}

/** Pid van de daemon van DEZE run (exact pad van het binaire bestand van deze run). */
export function daemonPids(): number[] {
  try {
    return execFileSync("pgrep", ["-x", "-f", env("IT_DAEMON_BIN")]).toString().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

export async function restartDaemon(downMs = 0) {
  for (const pid of daemonPids()) process.kill(pid, "SIGTERM");
  const end = Date.now() + 20_000;
  while (daemonPids().length && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  if (downMs) await new Promise((r) => setTimeout(r, downMs));
  const log = createWriteStream(`${env("IT_WORK")}/daemon-qa.log`, { flags: "a" });
  const d = spawn(env("IT_DAEMON_BIN"), [], { env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  d.stdout!.pipe(log);
  d.stderr!.pipe(log);
  d.unref();
  await waitFor("daemon", async () => (await fetch(`${env("IT_DAEMON_URL")}/api/system`, { headers: { authorization: `Bearer ${env("NODE_TOKEN")}` } })).ok, 40_000, 500);
}
