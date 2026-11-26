/** Hulpmiddelen voor de integratietest. Eigenaar: orchestrator. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { AppRouter } from "@panel/api";
import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";

export const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} ontbreekt (start via tests/integration/run.sh)`);
  return v;
};

export const PANEL = () => env("IT_PANEL_URL");
export const DAEMON = () => env("IT_DAEMON_URL");

/** Logt in via de test-login (PANEL_INSECURE_TEST_LOGIN) en geeft een getypeerde client. */
export async function login(discordId: string, name: string) {
  const res = await fetch(`${PANEL()}/api/auth/test/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ discordId, name }),
    redirect: "manual",
  });
  if (res.status !== 200 && res.status !== 204) throw new Error(`test-login ${res.status}: ${await res.text()}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!cookie.includes("panel_session=")) throw new Error(`geen panel_session-cookie: ${cookie}`);
  return { cookie, api: client(cookie) };
}

export function client(cookie: string | null) {
  return createTRPCClient<AppRouter>({
    links: [httpLink({ url: `${PANEL()}/api/trpc`, transformer: superjson, headers: () => (cookie ? { cookie } : {}) })],
  });
}

/** RFC 6238 TOTP (SHA-1, 6 cijfers, 30 s), zodat de test geen extra dependency nodig heeft. */
export function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretBase32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs: number, everyMs = 2000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timeout: ${what}${last ? ` (laatste fout: ${String(last)})` : ""}`);
}

// ---------- daemon-proces ----------

let daemon: ChildProcess | null = null;

export function startDaemon(): ChildProcess {
  const log = createWriteStream(env("IT_DAEMON_LOG"), { flags: "a" });
  daemon = spawn(env("IT_DAEMON_BIN"), [], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout!.pipe(log);
  daemon.stderr!.pipe(log);
  return daemon;
}

export async function stopDaemon(): Promise<void> {
  const d = daemon;
  if (!d || d.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    d.once("exit", () => resolve());
    d.kill("SIGTERM");
    setTimeout(() => d.kill("SIGKILL"), 10_000);
  });
  daemon = null;
}

export async function waitDaemonUp(): Promise<void> {
  await waitFor(
    "daemon /api/system",
    async () => (await fetch(`${DAEMON()}/api/system`, { headers: { authorization: `Bearer ${env("NODE_TOKEN")}` } })).ok,
    30_000,
    500,
  );
}

// ---------- console-websocket ----------

export type WsMsg = { event: string; [k: string]: unknown };

export class Console {
  readonly messages: WsMsg[] = [];
  private ws: WebSocket;
  readonly opened: Promise<void>;
  closedWith: number | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(new Error(`ws-fout: ${String((e as ErrorEvent).message ?? e.type)}`)));
    });
    this.ws.addEventListener("message", (e) => this.messages.push(JSON.parse(String(e.data)) as WsMsg));
    this.ws.addEventListener("close", (e) => (this.closedWith = e.code));
  }

  send(msg: WsMsg) {
    this.ws.send(JSON.stringify(msg));
  }

  async waitFor(what: string, pred: (m: WsMsg) => boolean, timeoutMs: number): Promise<WsMsg> {
    return waitFor(what, async () => this.messages.find(pred), timeoutMs, 250);
  }

  lines(): string[] {
    return this.messages.filter((m) => m.event === "console_output").map((m) => String(m.line));
  }

  close() {
    this.ws.close();
  }
}
