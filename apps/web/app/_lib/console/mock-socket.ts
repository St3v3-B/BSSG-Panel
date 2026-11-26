/**
 * Nep-daemon voor de console in mock-modus (er draait dan geen daemon). Spreekt hetzelfde
 * protocol als de echte (openapi.yaml): auth → auth_success + backlog + status, stats elke 2 s,
 * af en toe een logregel, commando's en power-acties, en token_expiring/token_expired.
 */
import type { Permission, PowerAction, ServerStatus } from "@panel/api";
import { CLOSE_TOKEN_INVALID, SOCKET_OPEN, type SocketLike, type WsClientMessage, type WsServerMessage } from "./types";

export interface MockSocketOptions {
  status: ServerStatus;
  permissions: Permission[];
  memoryLimitBytes: number;
  diskLimitBytes: number;
  /** Levensduur van een token in de mock. Standaard 2 min (echt: 10 min), zodat je de refresh ziet. */
  tokenLifetimeMs?: number;
  /** Interval van stats-berichten (protocol: 2 s). */
  statsIntervalMs?: number;
  /** Tijdsfactor voor opstarten/stoppen (tests zetten dit laag). */
  speed?: number;
  /** Soort logregels: Minecraft (game) of nginx/PHP (web). */
  flavor?: "game" | "web";
}

const WEB_STARTUP = [
  "nginx: [notice] using the \"epoll\" event method",
  "nginx: [notice] nginx/1.27.3",
  "php-fpm: [NOTICE] fpm is running, pid 1",
  "php-fpm: [NOTICE] ready to handle connections",
];
const WEB_CHATTER = [
  '198.51.100.23 - - "GET / HTTP/1.1" 200 5123 "-" "Mozilla/5.0"',
  '198.51.100.23 - - "GET /style.css HTTP/1.1" 200 1840 "-" "Mozilla/5.0"',
  '203.0.113.99 - - "GET /wp-login.php HTTP/1.1" 404 153 "-" "curl/8.5"',
  '198.51.100.23 - - "POST /contact.php HTTP/1.1" 500 0 "-" "Mozilla/5.0"',
  "php-fpm: [WARNING] [pool www] server reached pm.max_children setting (5), consider raising it",
  '198.51.100.40 - - "GET /favicon.ico HTTP/1.1" 200 4286 "-" "Mozilla/5.0"',
  "PHP Fatal error:  Uncaught Error: Call to undefined function mysql_connect() in /home/container/public/contact.php:12",
];

const ALL: Permission[] = ["console.read", "console.write", "files.read", "files.write", "backup.create", "backup.restore", "database.manage", "domain.manage", "schedule.manage", "power"];

const ts = () => new Date().toLocaleTimeString("nl-NL", { hour12: false, timeZone: "Europe/Amsterdam" });
const info = (s: string) => `[${ts()} INFO]: ${s}`;
const warn = (s: string) => `[${ts()} WARN]: ${s}`;

const STARTUP = [
  "Starting org.bukkit.craftbukkit.Main",
  "Environment: Environment[sessionHost=https://sessionserver.mojang.com, servicesHost=https://api.minecraftservices.com, name=PROD]",
  "Loaded 1290 recipes",
  "Starting minecraft server version 1.21.4",
  "Loading properties",
  "This server is running Paper version 1.21.4-232 (MC: 1.21.4)",
  "Server Ping Player Sample Count: 12",
  "Using 4 threads for Netty based IO",
  "Default game type: SURVIVAL",
  "Preparing level \"world\"",
  "Preparing start region for dimension minecraft:overworld",
  "Time elapsed: 1843 ms",
  "Preparing start region for dimension minecraft:the_nether",
  "Preparing start region for dimension minecraft:the_end",
  "Running delayed init tasks",
];

const CHATTER = [
  "UUID of player Blokgenoot is 069a79f4-44e9-4726-a5be-fca90e38aaf5",
  "Blokgenoot joined the game",
  "Blokgenoot[/198.51.100.23:51234] logged in with entity id 214 at ([world]12.5, 64.0, -33.2)",
  "<Blokgenoot> hoi allemaal!",
  "Blokgenoot has made the advancement [Stone Age]",
  "Saving the game (this may take a moment!)",
  "Saved the game",
  "Blokgenoot lost connection: Disconnected",
  "Blokgenoot left the game",
];

export class MockSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;

  private status: ServerStatus;
  private authed = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private chatterTimer: ReturnType<typeof setInterval> | null = null;
  private expiringTimer: ReturnType<typeof setTimeout> | null = null;
  private expiredTimer: ReturnType<typeof setTimeout> | null = null;
  private rx = 1_200_000;
  private tx = 3_400_000;
  private startedAt = Date.now() - 3_600_000;
  private chatterIndex = 0;
  private readonly o: Required<MockSocketOptions>;

  constructor(
    readonly url: string,
    opts: MockSocketOptions,
  ) {
    this.o = { tokenLifetimeMs: 120_000, statsIntervalMs: 2000, speed: 1, flavor: "game", ...opts };
    this.status = opts.status;
    this.later(30, () => {
      this.readyState = SOCKET_OPEN;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    if (this.readyState !== SOCKET_OPEN) throw new Error("socket is niet open");
    const msg = JSON.parse(data) as WsClientMessage;
    if (msg.event === "auth") return this.auth(msg.token);
    if (!this.authed) return;
    switch (msg.event) {
      case "send_command":
        return this.command(msg.command);
      case "set_state":
        return this.simulatePower(msg.state);
      case "request_stats":
        return this.sendStats();
    }
  }

  close(code = 1000, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.clearAll();
    const cb = this.onclose;
    queueMicrotask(() => cb?.({ code, reason }));
  }

  /** Power-actie naspelen (ook gebruikt als de UI power via tRPC doet). */
  simulatePower(action: PowerAction): void {
    if (!this.authed) return;
    const step = (ms: number) => ms / this.o.speed;
    if (action === "kill") {
      this.daemon("warning", "Server is geforceerd gestopt (kill).");
      return this.setStatus("offline");
    }
    if (action === "stop" || action === "restart") {
      if (this.status === "offline") {
        if (action === "stop") return;
      } else {
        this.setStatus("stopping");
        this.out(info("Stopping the server"));
        this.out(info("Stopping server"));
        this.out(info("Saving players"));
        this.out(info("Saving worlds"));
        this.later(step(900), () => {
          this.out(info("Flushing Chunk IO"));
          this.setStatus("offline");
          if (action === "restart") this.simulatePower("start");
        });
        return;
      }
    }
    if (this.status === "disk_exceeded") return this.error("Starten geweigerd: de schijflimiet is bereikt.");
    if (this.status === "online" || this.status === "starting") return;
    this.setStatus("starting");
    this.startedAt = Date.now();
    this.daemon("info", "Container wordt gestart…");
    this.startup.forEach((l, i) => this.later(step(150 + i * 120), () => this.out(this.web ? l : info(l))));
    this.later(step(150 + this.startup.length * 120 + 200), () => {
      if (!this.web) this.out(info(`Done (${(2 + Math.random() * 2).toFixed(3)}s)! For help, type "help"`));
      this.setStatus("online");
    });
  }

  // ---------- intern ----------

  private get web() {
    return this.o.flavor === "web";
  }
  private get startup() {
    return this.web ? WEB_STARTUP : STARTUP;
  }

  private auth(token: string) {
    if (!token) {
      this.error("token ontbreekt");
      return this.close(CLOSE_TOKEN_INVALID, "token ongeldig");
    }
    const fresh = !this.authed;
    this.authed = true;
    this.emit({ event: "auth_success", permissions: this.o.permissions.length ? this.o.permissions : ALL });
    this.scheduleExpiry();
    if (!fresh) return;
    // backlog
    if (this.status === "installing" || this.status === "install_failed") {
      (this.web ? ["Installatie gestart", "public/ aangemaakt", "index.html geplaatst"] : ["Installatie gestart", "Paper 1.21.4 downloaden…", "server.jar opgeslagen (48 MB)", "eula.txt aangemaakt"]).forEach((l) =>
        this.emit({ event: "install_output", line: l }),
      );
      if (this.status === "install_failed") this.emit({ event: "install_output", line: "FOUT: install-script stopte met code 1" });
    } else if (this.status === "online" || this.status === "starting") {
      for (const l of this.startup) this.out(this.web ? l : info(l));
      if (!this.web) this.out(info('Done (3.214s)! For help, type "help"'));
      this.out(this.web ? "[mock] Dit zijn nep-logs: er draait geen daemon in mock-modus." : info("[mock] Dit is een nep-console: er draait geen daemon in mock-modus."));
    } else {
      this.out(info("[mock] Server staat uit. Start hem met de knop hierboven."));
    }
    this.emit({ event: "status", state: this.status === "unknown" ? "offline" : this.status });
    this.syncLoops();
    this.sendStats();
  }

  private scheduleExpiry() {
    if (this.expiringTimer) clearTimeout(this.expiringTimer);
    if (this.expiredTimer) clearTimeout(this.expiredTimer);
    const life = this.o.tokenLifetimeMs;
    const warnAt = Math.max(0, life - 60_000);
    this.expiringTimer = setTimeout(() => {
      this.emit({ event: "token_expiring", expires_at: new Date(Date.now() + (life - warnAt)).toISOString() });
    }, warnAt);
    this.expiredTimer = setTimeout(() => {
      this.emit({ event: "token_expired" });
      this.close(CLOSE_TOKEN_INVALID, "token verlopen");
    }, life);
  }

  private command(cmd: string) {
    if (!this.o.permissions.includes("console.write") && this.o.permissions.length) return this.error("recht console.write ontbreekt");
    if (this.status !== "online") return this.error("De server draait niet.");
    const c = cmd.trim().replace(/^\//, "");
    const [name] = c.split(/\s+/);
    switch (name) {
      case "list":
        return this.out(info("There are 1 of a max of 20 players online: Blokgenoot"));
      case "help":
        return ["--------- Help: Index ---------", "Use /help [n] to get page n of help.", "/list, /say, /save-all, /stop, /tps"].forEach((l) => this.out(info(l)));
      case "say":
        return this.out(info(`[Server] ${c.slice(4)}`));
      case "tps":
        return this.out(info("TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0"));
      case "save-all":
        this.out(info("Saving the game (this may take a moment!)"));
        return this.later(400, () => this.out(info("Saved the game")));
      case "stop":
        return this.simulatePower("stop");
      default:
        return this.out(info('Unknown or incomplete command, see below for error') + `\n${c}<--[HERE]`);
    }
  }

  private setStatus(s: ServerStatus) {
    this.status = s;
    this.emit({ event: "status", state: s });
    this.syncLoops();
    this.sendStats();
  }

  private syncLoops() {
    const running = this.status === "online" || this.status === "starting" || this.status === "stopping";
    if (running && !this.statsTimer) this.statsTimer = setInterval(() => this.sendStats(), this.o.statsIntervalMs);
    if (!running && this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    const online = this.status === "online";
    if (online && !this.chatterTimer)
      this.chatterTimer = setInterval(() => {
        if (this.web) return this.out(WEB_CHATTER[this.chatterIndex++ % WEB_CHATTER.length]!);
        const line = CHATTER[this.chatterIndex++ % CHATTER.length]!;
        this.out(this.chatterIndex % 7 === 0 ? warn("Can't keep up! Is the server overloaded? Running 2034ms or 40 ticks behind") : info(line));
      }, 6000);
    if (!online && this.chatterTimer) {
      clearInterval(this.chatterTimer);
      this.chatterTimer = null;
    }
  }

  private sendStats() {
    if (!this.authed) return;
    const running = this.status === "online" || this.status === "starting" || this.status === "stopping";
    if (!running) return;
    this.rx += Math.round(5_000 + Math.random() * 60_000);
    this.tx += Math.round(10_000 + Math.random() * 120_000);
    const mem = this.o.memoryLimitBytes * (0.45 + Math.random() * 0.15);
    this.emit({
      event: "stats",
      cpu_pct: this.status === "starting" ? 120 + Math.random() * 60 : 15 + Math.random() * 45,
      memory_bytes: Math.round(mem),
      memory_limit_bytes: this.o.memoryLimitBytes,
      network_rx_bytes: this.rx,
      network_tx_bytes: this.tx,
      disk_bytes: Math.round(this.o.diskLimitBytes * 0.21),
      disk_limit_bytes: this.o.diskLimitBytes,
      uptime_ms: Date.now() - this.startedAt,
    });
  }

  private out(line: string) {
    for (const l of line.split("\n")) this.emit({ event: "console_output", line: l });
  }
  private daemon(level: "info" | "warning" | "error", line: string) {
    this.emit({ event: "daemon_message", level, line });
  }
  private error(message: string) {
    this.emit({ event: "error", message });
  }

  private emit(msg: WsServerMessage) {
    if (this.readyState !== SOCKET_OPEN) return;
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private clearAll() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.chatterTimer) clearInterval(this.chatterTimer);
    if (this.expiringTimer) clearTimeout(this.expiringTimer);
    if (this.expiredTimer) clearTimeout(this.expiredTimer);
    this.statsTimer = this.chatterTimer = this.expiringTimer = this.expiredTimer = null;
  }
}
