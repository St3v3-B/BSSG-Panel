/**
 * Verbinding met de console-websocket van de daemon (protocol: packages/api/openapi.yaml).
 *
 * - haalt een token op (servers.consoleToken), opent de socket en stuurt `auth`
 * - `token_expiring` → nieuw token ophalen → opnieuw `auth` op dezelfde socket
 * - verbinding weg (of 4001 token verlopen) → opnieuw verbinden met exponentiële backoff
 * - 4003 (geen console.read) / 4004 (server onbekend) → stoppen ("denied")
 *
 * Los van React en van de echte WebSocket, zodat het te testen is met een nep-socket.
 */
import {
  CLOSE_NO_CONSOLE_READ,
  CLOSE_UNKNOWN_SERVER,
  SOCKET_OPEN,
  type ConnState,
  type SocketFactory,
  type SocketLike,
  type WsClientMessage,
  type WsServerMessage,
} from "./types";

export interface ConsoleToken {
  token: string;
  socketUrl: string;
}

export interface Backoff {
  initialMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { initialMs: 1000, maxMs: 30_000 };

export function backoffDelay(attempt: number, b: Backoff = DEFAULT_BACKOFF): number {
  return Math.min(b.maxMs, b.initialMs * 2 ** Math.max(0, attempt));
}

export interface ConsoleConnectionOptions {
  fetchToken: () => Promise<ConsoleToken>;
  createSocket: SocketFactory;
  /** Elk bericht van de daemon. `fresh` = eerste auth_success op een nieuwe socket (backlog volgt). */
  onMessage?: (msg: WsServerMessage, meta: { fresh: boolean }) => void;
  onState?: (state: ConnState, info: { retryInMs?: number; closeCode?: number }) => void;
  /** Token ophalen mislukt; geeft true terug als opnieuw proberen geen zin heeft (bv. FORBIDDEN). */
  onTokenError?: (err: unknown) => boolean | void;
  /** Na een geslaagde token-refresh (handig voor de UI en tests). */
  onTokenRefreshed?: () => void;
  backoff?: Backoff;
}

export class ConsoleConnection {
  private socket: SocketLike | null = null;
  private generation = 0;
  private attempt = 0;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = false;
  private authedOnSocket = false;
  private _state: ConnState = "idle";

  constructor(private readonly opts: ConsoleConnectionOptions) {}

  get state(): ConnState {
    return this._state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.clearRetry();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close(1000, "client stopt");
      } catch {
        /* al dicht */
      }
    }
    this.setState("closed");
  }

  /** Direct opnieuw verbinden (knop in de UI), ook vanuit "denied". */
  retryNow(): void {
    this.stop();
    this.start();
  }

  /** Stuurt een bericht als de verbinding geauthenticeerd is. */
  send(msg: WsClientMessage): boolean {
    const s = this.socket;
    if (!s || s.readyState !== SOCKET_OPEN || this._state !== "connected") return false;
    s.send(JSON.stringify(msg));
    return true;
  }

  /** De onderliggende socket (bv. om de mock-socket een power-actie te laten naspelen). */
  get currentSocket(): SocketLike | null {
    return this.socket;
  }

  private setState(state: ConnState, info: { retryInMs?: number; closeCode?: number } = {}) {
    this._state = state;
    this.opts.onState?.(state, info);
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async connect(): Promise<void> {
    this.clearRetry();
    const gen = ++this.generation;
    this.setState("connecting");
    let tok: ConsoleToken;
    try {
      tok = await this.opts.fetchToken();
    } catch (err) {
      if (gen !== this.generation || this.stopped) return;
      if (this.opts.onTokenError?.(err) === true) {
        this.setState("denied");
        return;
      }
      this.scheduleReconnect();
      return;
    }
    if (gen !== this.generation || this.stopped) return;

    let ws: SocketLike;
    try {
      ws = this.opts.createSocket(tok.socketUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    this.authedOnSocket = false;

    ws.onopen = () => {
      if (gen !== this.generation) return;
      this.setState("authenticating");
      ws.send(JSON.stringify({ event: "auth", token: tok.token } satisfies WsClientMessage));
    };
    ws.onmessage = (ev) => {
      if (gen !== this.generation) return;
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as WsServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg.event !== "string") return;
      this.handle(msg, ws);
    };
    ws.onerror = () => {
      /* er volgt altijd een close */
    };
    ws.onclose = (ev) => {
      if (gen !== this.generation) return;
      this.socket = null;
      if (this.stopped) return;
      if (ev.code === CLOSE_NO_CONSOLE_READ || ev.code === CLOSE_UNKNOWN_SERVER) {
        this.setState("denied", { closeCode: ev.code });
        return;
      }
      this.scheduleReconnect(ev.code);
    };
  }

  private handle(msg: WsServerMessage, ws: SocketLike) {
    let fresh = false;
    if (msg.event === "auth_success") {
      fresh = !this.authedOnSocket;
      this.authedOnSocket = true;
      this.attempt = 0;
      this.setState("connected");
    } else if (msg.event === "token_expiring") {
      void this.refresh(ws);
    }
    this.opts.onMessage?.(msg, { fresh });
  }

  private async refresh(ws: SocketLike) {
    if (this.refreshing) return;
    this.refreshing = true;
    const gen = this.generation;
    try {
      const tok = await this.opts.fetchToken();
      if (gen !== this.generation || this.socket !== ws || ws.readyState !== SOCKET_OPEN) return;
      ws.send(JSON.stringify({ event: "auth", token: tok.token } satisfies WsClientMessage));
      this.opts.onTokenRefreshed?.();
    } catch (err) {
      // Lukt het niet, dan sluit de daemon straks met 4001 en verbinden we opnieuw.
      this.opts.onTokenError?.(err);
    } finally {
      this.refreshing = false;
    }
  }

  private scheduleReconnect(closeCode?: number) {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt++, this.opts.backoff);
    this.setState("reconnecting", { retryInMs: delay, closeCode });
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }
}
