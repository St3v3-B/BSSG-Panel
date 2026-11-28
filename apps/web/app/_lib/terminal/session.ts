/**
 * Webterminal-sessie met de daemon (protocol: "Webterminal" in packages/api/openapi.yaml).
 * - token ophalen (servers.terminalToken), socket openen, `auth` met cols/rows
 * - binaire frames = uitvoer/invoer; tekst = JSON-besturing (resize, auth, token_expiring, terminal_exit, error)
 * - `token_expiring` → nieuw token (refresh: true) → opnieuw `auth` op dezelfde socket
 * Geen automatisch opnieuw verbinden: een nieuwe verbinding is een nieuwe shell; de gebruiker kiest dat zelf.
 * Los van React en van de echte WebSocket, zodat het te testen is.
 */

export interface TerminalSocket {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type TerminalSocketFactory = (url: string) => TerminalSocket;

export const CLOSE_TERMINAL = { tokenInvalid: 4001, noPermission: 4003, unknown: 4004, authTimeout: 4008, idle: 4009, tooMany: 4029 } as const;

export type TerminalState = "idle" | "connecting" | "connected" | "closed";

export interface TerminalCloseInfo {
  code?: number;
  /** Exitcode van de shell als die zelf stopte. */
  exitCode?: number;
  /** Foutmelding van de daemon of het ophalen van het token. */
  message?: string;
}

export interface TerminalSessionOptions {
  fetchToken: (refresh: boolean) => Promise<{ token: string; socketUrl: string }>;
  createSocket: TerminalSocketFactory;
  onOutput: (data: Uint8Array) => void;
  onState: (state: TerminalState, info: TerminalCloseInfo) => void;
  /** Na een geslaagde token-refresh. */
  onTokenRefreshed?: () => void;
}

const enc = new TextEncoder();

export class TerminalSession {
  private socket: TerminalSocket | null = null;
  private state: TerminalState = "idle";
  private exitCode: number | undefined;
  private message: string | undefined;
  private size = { cols: 80, rows: 24 };

  constructor(private o: TerminalSessionOptions) {}

  get current(): TerminalState {
    return this.state;
  }

  private set(state: TerminalState, info: TerminalCloseInfo = {}) {
    this.state = state;
    this.o.onState(state, info);
  }

  async start(cols: number, rows: number): Promise<void> {
    if (this.state === "connecting" || this.state === "connected") return;
    this.size = { cols, rows };
    this.exitCode = undefined;
    this.message = undefined;
    this.set("connecting");
    let tok: { token: string; socketUrl: string };
    try {
      tok = await this.o.fetchToken(false);
    } catch (e) {
      this.set("closed", { message: e instanceof Error ? e.message : String(e) });
      return;
    }
    const s = this.o.createSocket(tok.socketUrl);
    s.binaryType = "arraybuffer";
    this.socket = s;
    s.onopen = () => s.send(JSON.stringify({ event: "auth", token: tok.token, cols: this.size.cols, rows: this.size.rows }));
    s.onmessage = (ev) => this.onMessage(s, ev.data);
    s.onerror = () => {};
    s.onclose = (ev) => {
      if (this.socket !== s) return;
      this.socket = null;
      this.set("closed", { code: ev.code, exitCode: this.exitCode, message: this.message ?? ev.reason });
    };
  }

  private onMessage(s: TerminalSocket, data: unknown) {
    if (typeof data !== "string") {
      // ArrayBuffer (binaryType "arraybuffer") of een view; geen instanceof (andere realm in tests/iframes)
      if (ArrayBuffer.isView(data)) this.o.onOutput(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      else if (data && typeof data === "object" && "byteLength" in data) this.o.onOutput(new Uint8Array(data as ArrayBuffer));
      return;
    }
    let m: { event?: string; code?: number; message?: string };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    switch (m.event) {
      case "auth_success":
        if (this.state !== "connected") this.set("connected");
        break;
      case "token_expiring":
        void this.o
          .fetchToken(true)
          .then((t) => {
            if (this.socket === s) {
              s.send(JSON.stringify({ event: "auth", token: t.token }));
              this.o.onTokenRefreshed?.();
            }
          })
          .catch(() => {});
        break;
      case "terminal_exit":
        this.exitCode = m.code;
        break;
      case "error":
        this.message = m.message;
        break;
    }
  }

  /** Toetsenbordinvoer (xterm onData). */
  write(data: string | Uint8Array): void {
    const s = this.socket;
    if (!s || this.state !== "connected" || s.readyState !== 1) return;
    s.send(typeof data === "string" ? enc.encode(data) : data);
  }

  resize(cols: number, rows: number): void {
    if (cols === this.size.cols && rows === this.size.rows) return;
    this.size = { cols, rows };
    const s = this.socket;
    if (s && this.state === "connected" && s.readyState === 1) s.send(JSON.stringify({ event: "resize", cols, rows }));
  }

  stop(): void {
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      try {
        s.close(1000, "closed");
      } catch {
        /* al dicht */
      }
    }
    if (this.state !== "idle" && this.state !== "closed") this.set("closed", {});
  }
}
