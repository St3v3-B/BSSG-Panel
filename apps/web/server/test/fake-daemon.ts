/** Nep-daemon (node:http) volgens packages/api/openapi.yaml, voor tests van de daemon-client en procedures. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DaemonServerSpec, DaemonServerState } from "@panel/api";

export interface RecordedRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

export class FakeDaemon {
  readonly requests: RecordedRequest[] = [];
  readonly servers = new Map<string, { spec: DaemonServerSpec; state: DaemonServerState["state"]; installedAt: string | null }>();
  /** "ok" | "hang" (geen antwoord) | "error500" */
  mode: "ok" | "hang" | "error500" = "ok";
  /** Override per pad: geef een Response-achtig object terug of undefined voor standaardgedrag. */
  override: ((r: RecordedRequest) => { status: number; body?: unknown } | undefined) | null = null;
  private server: Server | null = null;
  url = "";

  constructor(public token: string) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  reset(): void {
    this.requests.length = 0;
    this.servers.clear();
    this.mode = "ok";
    this.override = null;
  }

  last(method: string, pathPrefix: string): RecordedRequest | undefined {
    return [...this.requests].reverse().find((r) => r.method === method && r.path.startsWith(pathPrefix));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    let body: unknown = undefined;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const r: RecordedRequest = { method: req.method ?? "GET", path: req.url ?? "/", auth: req.headers.authorization, body };
    this.requests.push(r);
    const send = (status: number, b?: unknown) => {
      if (b === undefined) {
        res.writeHead(status).end();
        return;
      }
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
    };
    if (this.mode === "hang") return; // nooit antwoorden
    if (this.mode === "error500") return send(500, { error: "internal", message: "kapot" });
    if (r.auth !== `Bearer ${this.token}`) return send(401, { error: "unauthorized" });
    const o = this.override?.(r);
    if (o) return send(o.status, o.body);

    const path = r.path.split("?")[0]!;
    const m = /^\/api\/servers\/([0-9a-f-]{36})(\/[a-z]+)?$/.exec(path);
    if (path === "/api/system" && r.method === "GET") {
      return send(200, {
        version: "fake-1.0",
        disk_quota_mode: "soft",
        cpu_count: 4,
        memory_total_bytes: 8 * 1024 ** 3,
        memory_used_bytes: 2 * 1024 ** 3,
        disk_total_bytes: 100 * 1024 ** 3,
        disk_free_bytes: 50 * 1024 ** 3,
        docker_version: "27.0",
        server_count: this.servers.size,
      });
    }
    if (path === "/api/servers" && r.method === "GET") return send(200, [...this.servers.keys()].map((u) => this.state(u)));
    if (path === "/api/servers" && r.method === "POST") {
      const spec = body as DaemonServerSpec;
      this.servers.set(spec.uuid, { spec, state: "installing", installedAt: null });
      return send(202, this.state(spec.uuid));
    }
    if (!m) return send(404, { error: "not_found" });
    const uuid = m[1]!;
    const sub = m[2] ?? "";
    const s = this.servers.get(uuid);
    if (!s) return send(404, { error: "not_found" });
    switch (`${r.method} ${sub}`) {
      case "GET ":
        return send(200, this.state(uuid));
      case "PUT ":
        s.spec = body as DaemonServerSpec;
        return send(200, this.state(uuid));
      case "DELETE ":
        this.servers.delete(uuid);
        return send(204);
      case "POST /install":
        s.state = "installing";
        return send(202);
      case "POST /power": {
        const action = (body as { action: string }).action;
        if (s.state === "installing") return send(409, { error: "invalid_state", message: "installing" });
        s.state = action === "start" || action === "restart" ? "starting" : "offline";
        return send(202);
      }
      case "POST /commands":
        if (s.state !== "online" && s.state !== "starting") return send(409, { error: "not_running" });
        return send(204);
      case "GET /stats":
        return send(200, {
          cpu_pct: 12.5,
          memory_bytes: 500 * 1024 * 1024,
          memory_limit_bytes: s.spec.limits.memory_mb * 1024 * 1024,
          network_rx_bytes: 1,
          network_tx_bytes: 2,
          disk_bytes: 3,
          disk_limit_bytes: s.spec.limits.disk_mb * 1024 * 1024,
          uptime_ms: s.state === "online" ? 1000 : 0,
        });
      default:
        return send(404, { error: "not_found" });
    }
  }

  private state(uuid: string): DaemonServerState {
    const s = this.servers.get(uuid)!;
    return { uuid, state: s.state, disk_bytes: 0, disk_exceeded: false, started_at: null, installed_at: s.installedAt };
  }
}
