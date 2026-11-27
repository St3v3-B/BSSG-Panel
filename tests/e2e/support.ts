/** Hulpmiddelen voor de browsertests. Hergebruikt de API-helpers van de integratietest. */
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { adminLogin, env, login } from "../integration/helpers";

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
    up.addEventListener("close", (e) => ws.close({ code: e.code === 1005 ? 1000 : e.code, reason: e.reason }));
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
      body: req.postDataBuffer() ?? undefined,
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

/** Admin: eigenaar met 2FA, in dezelfde sessie geverifieerd. */
export async function asAdmin(context: BrowserContext) {
  const s = await adminLogin();
  await setSession(context, s.cookie);
  return s;
}

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await routeDaemon(page);
    await use(page);
  },
});
