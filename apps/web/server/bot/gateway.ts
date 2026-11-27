/**
 * Minimale Discord-gateway-client (ruwe websocket, geen discord.js): verbinden, heartbeat,
 * identify, slash-commando's registreren en interacties beantwoorden. Alleen interacties, dus
 * geen intents. Valt de verbinding weg, dan opnieuw met backoff; een ongeldig token stopt de bot.
 * Het panel zelf blijft altijd werken: alles hier vangt zijn eigen fouten af.
 */
import { COMMANDS, runCommand, suggest, type Reply } from "./commands";

const API = "https://discord.com/api/v10";
const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
/** Sluitcodes waarbij opnieuw proberen geen zin heeft (token of intents ongeldig). */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export interface WsLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface BotOptions {
  token: string;
  makeSocket?: (url: string) => WsLike;
  fetchFn?: typeof fetch;
  /** Commando-uitvoering (vervangbaar in tests). */
  run?: (discordId: string, name: string, arg?: string) => Promise<Reply>;
  complete?: (discordId: string, typed: string) => Promise<{ name: string; value: string }[]>;
  log?: Pick<Console, "info" | "warn" | "error">;
  /** Max aantal commando's per gebruiker per 10 s. */
  rateLimit?: number;
}

interface Interaction {
  id: string;
  token: string;
  type: number; // 2 = commando, 4 = autocomplete
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: { name: string; options?: { name: string; value?: string; focused?: boolean }[] };
}

export class DiscordBot {
  private ws: WsLike | null = null;
  private seq: number | null = null;
  private hb: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;
  private registered = false;
  private readonly hits = new Map<string, number[]>();
  private readonly f: typeof fetch;
  private readonly log: NonNullable<BotOptions["log"]>;

  constructor(private readonly o: BotOptions) {
    this.f = o.fetchFn ?? ((...a) => fetch(...a));
    this.log = o.log ?? console;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.hb) clearInterval(this.hb);
    if (this.retry) clearTimeout(this.retry);
    this.hb = this.retry = null;
    try {
      this.ws?.close(1000);
    } catch {
      /* al dicht */
    }
    this.ws = null;
  }

  private connect(): void {
    try {
      const make = this.o.makeSocket ?? ((u: string) => new WebSocket(u) as unknown as WsLike);
      const ws = make(GATEWAY);
      this.ws = ws;
      ws.onmessage = (ev) => {
        try {
          this.onPayload(JSON.parse(String(ev.data)));
        } catch (e) {
          this.log.warn("[bot] bad gateway payload:", (e as Error).message);
        }
      };
      ws.onclose = (ev) => this.onClose(ev.code);
      ws.onerror = () => {
        /* onclose volgt */
      };
    } catch (e) {
      this.log.warn("[bot] connect failed:", (e as Error).message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const wait = Math.min(300_000, 2000 * 2 ** Math.min(this.attempts++, 8));
    this.retry = setTimeout(() => this.connect(), wait);
    this.retry.unref?.();
  }

  private onClose(code: number): void {
    if (this.hb) clearInterval(this.hb);
    this.hb = null;
    if (this.stopped) return;
    if (FATAL_CLOSE.has(code)) {
      this.log.error(`[bot] Discord rejected the connection (code ${code}); the bot is disabled. Check DISCORD_BOT_TOKEN.`);
      this.stopped = true;
      return;
    }
    this.log.warn(`[bot] connection closed (${code}); retrying`);
    this.scheduleReconnect();
  }

  private send(op: number, d: unknown): void {
    this.ws?.send(JSON.stringify({ op, d }));
  }

  private onPayload(p: { op: number; d: any; s?: number | null; t?: string | null }): void {
    if (typeof p.s === "number") this.seq = p.s;
    switch (p.op) {
      case 10: {
        const every = Number(p.d?.heartbeat_interval) || 41_250;
        if (this.hb) clearInterval(this.hb);
        this.hb = setInterval(() => this.send(1, this.seq), every);
        this.hb.unref?.();
        this.send(2, { token: this.o.token, intents: 0, properties: { os: "linux", browser: "panel", device: "panel" } });
        break;
      }
      case 1:
        this.send(1, this.seq);
        break;
      case 7: // server vraagt om opnieuw te verbinden
      case 9: // sessie ongeldig
        this.ws?.close(4000);
        break;
      case 0:
        if (p.t === "READY") {
          this.attempts = 0;
          this.log.info(`[bot] connected as ${p.d?.user?.username ?? "bot"}`);
          if (!this.registered) void this.register(String(p.d?.application?.id ?? p.d?.user?.id));
        } else if (p.t === "INTERACTION_CREATE") {
          void this.onInteraction(p.d as Interaction).catch((e) => this.log.error("[bot] interaction failed:", e));
        }
        break;
    }
  }

  private async rest(path: string, method: string, body: unknown): Promise<Response> {
    return this.f(`${API}${path}`, {
      method,
      headers: { authorization: `Bot ${this.o.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  }

  private async register(appId: string): Promise<void> {
    try {
      const r = await this.rest(`/applications/${appId}/commands`, "PUT", COMMANDS);
      if (r.ok) this.registered = true;
      else this.log.warn(`[bot] registering commands failed: HTTP ${r.status}`);
    } catch (e) {
      this.log.warn("[bot] registering commands failed:", (e as Error).message);
    }
  }

  private limited(id: string): boolean {
    const now = Date.now();
    const max = this.o.rateLimit ?? 5;
    const h = (this.hits.get(id) ?? []).filter((t) => now - t < 10_000);
    h.push(now);
    this.hits.set(id, h);
    if (this.hits.size > 1000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < 10_000)) this.hits.delete(k);
    return h.length > max;
  }

  /** Publiek voor tests. */
  async onInteraction(i: Interaction): Promise<void> {
    const uid = i.member?.user?.id ?? i.user?.id;
    if (!uid || !i.data) return;
    const reply = (data: unknown, type = 4) => this.rest(`/interactions/${i.id}/${i.token}/callback`, "POST", { type, data });
    if (i.type === 4) {
      const focused = i.data.options?.find((o) => o.focused);
      const choices = this.limited(uid) ? [] : await (this.o.complete ?? suggest)(uid, String(focused?.value ?? ""));
      await reply({ choices }, 8);
      return;
    }
    if (i.type !== 2) return;
    if (this.limited(uid)) {
      await reply({ content: "Slow down a little.", flags: 64 });
      return;
    }
    const arg = i.data.options?.find((o) => o.name === "name")?.value;
    const out = await (this.o.run ?? runCommand)(uid, i.data.name, arg);
    await reply({ ...out, flags: 64, allowed_mentions: { parse: [] } });
  }
}

let bot: DiscordBot | null = null;

/** Start de bot als DISCORD_BOT_TOKEN gezet is. Gooit nooit. */
export function startBot(token: string | undefined): void {
  if (!token || bot) return;
  try {
    bot = new DiscordBot({ token });
    bot.start();
  } catch (e) {
    console.error("[bot] could not start:", e);
    bot = null;
  }
}

export function stopBot(): void {
  bot?.stop();
  bot = null;
}
