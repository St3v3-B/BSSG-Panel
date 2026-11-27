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

class Raw {
  constructor(readonly text: string) {}
}

export class FakeDaemon {
  readonly requests: RecordedRequest[] = [];
  readonly servers = new Map<string, { spec: DaemonServerSpec; state: DaemonServerState["state"]; installedAt: string | null }>();
  /** "ok" | "hang" (geen antwoord) | "error500" */
  mode: "ok" | "hang" | "error500" = "ok";
  /** Vertraging (ms) voor elk antwoord, om een trage node na te bootsen. */
  delayMs = 0;
  /** Override per pad: geef een Response-achtig object terug of undefined voor standaardgedrag. */
  override: ((r: RecordedRequest) => { status: number; body?: unknown } | undefined) | null = null;
  /** Bestanden per server: pad → inhoud; mappen apart. */
  readonly files = new Map<string, Map<string, string>>();
  readonly dirs = new Map<string, Set<string>>();
  /** Alles wat schrijft geeft 507 disk_exceeded. */
  diskFull = false;
  /** transfer/export geeft 500. */
  exportFails = false;
  readonly routes = new Map<string, Record<string, unknown>>();
  /** Antwoord van POST /exec (standaard: geslaagd, geen uitvoer). */
  execResult: { exit_code: number; output: string; truncated: boolean; timed_out: boolean; duration_ms: number } = { exit_code: 0, output: "", truncated: false, timed_out: false, duration_ms: 5 };
  /** Databases van de (nep-)MariaDB van deze node: naam -> gebruiker, wachtwoord en inhoud ("dump"). */
  readonly dbs = new Map<string, { username: string; password: string; data: string }>();
  /** phpMyAdmin-accounts (PUT /api/db/pma-users/{user}): laatste wachtwoord en databases per gebruiker. */
  readonly pmaUsers = new Map<string, { password: string; databases: string[] }>();
  /** Optioneel: voer de sync echt uit (bv. op een testcontainer); een fout geeft 500. */
  pmaHook: ((user: string, password: string, databases: string[]) => Promise<void>) | null = null;
  /** Antwoord van GET /api/db/status. */
  dbAvailable = true;
  dbDumpFails = false;
  dbImportFails = false;
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
    this.files.clear();
    this.dirs.clear();
    this.routes.clear();
    this.diskFull = false;
    this.exportFails = false;
    this.dbs.clear();
    this.pmaUsers.clear();
    this.dbAvailable = true;
    this.dbDumpFails = false;
    this.dbImportFails = false;
    this.execResult = { exit_code: 0, output: "", truncated: false, timed_out: false, duration_ms: 5 };
    this.mode = "ok";
    this.delayMs = 0;
    this.override = null;
  }

  private handleDb(kind: string, name: string | undefined, sub: string | undefined, r: RecordedRequest, query: URLSearchParams, raw: string, send: (status: number, b?: unknown) => void) {
    if (kind === "status") return send(200, { available: this.dbAvailable, host: "panel-mariadb", ...(this.dbAvailable ? {} : { error: "mariadb unavailable" }) });
    if (!this.dbAvailable) return send(503, { error: "db_unavailable", message: "no MariaDB" });
    const b = (r.body ?? {}) as { name?: string; username?: string; password?: string };
    if (!name && r.method === "POST") {
      if (this.dbs.has(b.name!)) return send(409, { error: "exists" });
      this.dbs.set(b.name!, { username: b.username!, password: b.password!, data: "" });
      return send(204);
    }
    if (!name) return send(404, { error: "not_found" });
    const d = this.dbs.get(name);
    if (!sub && r.method === "DELETE") {
      this.dbs.delete(name);
      return send(204);
    }
    if (!d) return send(404, { error: "not_found" });
    if (sub === "password") {
      d.password = b.password!;
      return send(204);
    }
    if (sub === "dump") return this.dbDumpFails ? send(500, { error: "db_error", message: "dump kapot" }) : send(200, new Raw(d.data));
    if (sub === "import") {
      if (this.dbImportFails) return send(500, { error: "import_failed", message: "import kapot" });
      d.data = raw;
      return send(204);
    }
    return send(404, { error: "not_found" });
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
      if (b instanceof Raw) {
        res.writeHead(status, { "content-type": "application/octet-stream" }).end(b.text);
        return;
      }
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
    };
    if (this.mode === "hang") return; // nooit antwoorden
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.mode === "error500") return send(500, { error: "internal", message: "kapot" });
    if (r.auth !== `Bearer ${this.token}`) return send(401, { error: "unauthorized" });
    const o = this.override?.(r);
    if (o) return send(o.status, o.body);

    const path = r.path.split("?")[0]!;
    const query = new URLSearchParams(r.path.split("?")[1] ?? "");
    if (r.method === "POST" && path === "/api/images/check") return send(202);
    const pm = /^\/api\/db\/pma-users\/([^/]+)$/.exec(path);
    if (pm && r.method === "PUT") {
      const b = (body ?? {}) as { password?: string; databases?: string[] };
      const ok = /^pma_u[0-9]{1,18}$/.test(pm[1]!) && typeof b.password === "string" && b.password.length >= 8 && Array.isArray(b.databases) && b.databases.every((d) => /^[a-zA-Z0-9_]{1,64}$/.test(d) && !["mysql", "information_schema", "performance_schema", "sys"].includes(d.toLowerCase()));
      if (!ok) return send(400, { error: "bad_request" });
      if (!this.dbAvailable) return send(503, { error: "db_unavailable", message: "no MariaDB" });
      this.pmaUsers.set(pm[1]!, { password: b.password!, databases: b.databases! });
      try {
        await this.pmaHook?.(pm[1]!, b.password!, b.databases!);
      } catch (e) {
        return send(500, { error: "db_error", message: String(e) });
      }
      return send(204);
    }
    const dm = /^\/api\/db\/(status|databases)(?:\/([A-Za-z0-9_]+)(?:\/(password|dump|import))?)?$/.exec(path);
    if (dm) return this.handleDb(dm[1]!, dm[2], dm[3], r, query, raw, send);
    const fm = /^\/api\/servers\/([0-9a-f-]{36})\/files\/([a-z]+)$/.exec(path);
    if (fm) return this.handleFiles(fm[1]!, fm[2]!, r, query, raw, send);
    const rm = /^\/api\/routes(?:\/(.+))?$/.exec(path);
    if (rm) {
      const host = rm[1] ? decodeURIComponent(rm[1]) : null;
      if (!host && r.method === "GET") return send(200, [...this.routes.values()]);
      if (host && r.method === "PUT") {
        const route: Record<string, unknown> = { ...(body as Record<string, unknown>), ssl_status: "active", ssl_error: null, checked_at: null };
        if (!this.servers.has(route.server_uuid as string)) return send(404, { error: "not_found" });
        this.routes.set(host, route);
        return send(200, route);
      }
      if (host && r.method === "GET") return this.routes.has(host) ? send(200, this.routes.get(host)) : send(404, { error: "not_found" });
      if (host && r.method === "DELETE") {
        this.routes.delete(host);
        return send(204);
      }
      return send(404, { error: "not_found" });
    }
    const tm = /^\/api\/servers\/([0-9a-f-]{36})\/transfer\/(export|import)$/.exec(path);
    if (tm) {
      const s = this.servers.get(tm[1]!);
      if (!s) return send(404, { error: "not_found" });
      if (s.state !== "offline" && s.state !== "install_failed") return send(409, { error: "invalid_state" });
      const fs = this.fs(tm[1]!);
      if (tm[2] === "export") {
        if (this.exportFails) return send(500, { error: "internal", message: "export kapot" });
        return send(200, new Raw(JSON.stringify({ files: [...fs.files], dirs: [...fs.dirs] })));
      }
      if (this.diskFull) return send(507, { error: "disk_exceeded" });
      const t = JSON.parse(raw) as { files: [string, string][]; dirs: string[] };
      for (const [p, c] of t.files) fs.files.set(p, c);
      for (const d of t.dirs) fs.dirs.add(d);
      return send(204);
    }
    const m = /^\/api\/servers\/([0-9a-f-]{36})(\/[a-z-]+)?$/.exec(path);
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
      const skip = (spec as { skip_install?: boolean }).skip_install === true;
      this.servers.set(spec.uuid, { spec, state: skip ? "offline" : "installing", installedAt: skip ? new Date().toISOString() : null });
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
      case "POST /image-update":
        return send(202);
      case "POST /commands":
        if (s.state !== "online" && s.state !== "starting") return send(409, { error: "not_running" });
        return send(204);
      case "POST /exec":
        if (s.state !== "online" && s.state !== "starting") return send(409, { error: "not_running" });
        return send(200, this.execResult);
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

  fs(uuid: string) {
    if (!this.files.has(uuid)) this.files.set(uuid, new Map());
    if (!this.dirs.has(uuid)) this.dirs.set(uuid, new Set(["/"]));
    return { files: this.files.get(uuid)!, dirs: this.dirs.get(uuid)! };
  }

  private entry(path: string, isDir: boolean, size: number) {
    return { name: path.split("/").pop()!, path, is_directory: isDir, is_symlink: false, size, mode: isDir ? "drwxr-xr-x" : "-rw-r--r--", mime_type: isDir ? "inode/directory" : "text/plain", modified_at: "2026-01-01T00:00:00Z" };
  }

  private handleFiles(uuid: string, op: string, r: RecordedRequest, q: URLSearchParams, raw: string, send: (s: number, b?: unknown) => void) {
    if (!this.servers.has(uuid)) return send(404, { error: "not_found" });
    const { files, dirs } = this.fs(uuid);
    const b = (r.body ?? {}) as { path?: string; from?: string; to?: string; paths?: string[]; root?: string; query?: string; content?: boolean; limit?: number; mode?: string; dir_mode?: string; allow_special?: boolean };
    const writes = ["contents:PUT", "mkdir:POST", "compress:POST", "decompress:POST"];
    if (this.diskFull && writes.includes(`${op}:${r.method}`)) return send(507, { error: "disk_exceeded", message: "disk vol" });
    const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
    switch (`${op}:${r.method}`) {
      case "list:GET": {
        const dir = q.get("path") ?? "/";
        if (!dirs.has(dir)) return send(404, { error: "not_found" });
        const out = [
          ...[...dirs].filter((d) => d !== "/" && parent(d) === dir).map((d) => this.entry(d, true, 0)),
          ...[...files].filter(([f]) => parent(f) === dir).map(([f, c]) => this.entry(f, false, c.length)),
        ];
        return send(200, out);
      }
      case "contents:GET": {
        const c = files.get(q.get("path") ?? "");
        if (c === undefined) return send(404, { error: "not_found" });
        if (c.length > 5 * 1024 * 1024) return send(413, { error: "too_large" });
        return send(200, new Raw(c));
      }
      case "contents:PUT":
        files.set(q.get("path")!, raw);
        return send(204);
      case "mkdir:POST":
        if (dirs.has(b.path!)) return send(409, { error: "exists" });
        dirs.add(b.path!);
        return send(204);
      case "rename:POST": {
        const c = files.get(b.from!);
        if (c === undefined) return send(404, { error: "not_found" });
        files.delete(b.from!);
        files.set(b.to!, c);
        return send(204);
      }
      case "delete:POST":
        for (const p of b.paths ?? []) {
          files.delete(p);
          dirs.delete(p);
        }
        return send(204);
      case "compress:POST": {
        const path = `${b.root === "/" ? "" : b.root}/archive.tar.gz`;
        files.set(path, "tgz");
        return send(200, this.entry(path, false, 3));
      }
      case "decompress:POST":
        if (!files.has(b.path!)) return send(404, { error: "not_found" });
        return send(204);
      case "search:POST": {
        const q = (b.query ?? "").toLowerCase();
        const root = b.path ?? "/";
        if (!dirs.has(root)) return send(404, { error: "not_found" });
        const under = (p: string) => root === "/" || p.startsWith(`${root}/`);
        const name = (p: string) => p.split("/").pop()!.toLowerCase();
        const hits = b.content
          ? [...files].filter(([f]) => under(f)).flatMap(([f, c]) => {
              const matches = c.split("\n").flatMap((line, i) => (line.toLowerCase().includes(q) ? [{ line: i + 1, text: line }] : [])).slice(0, 5);
              return matches.length ? [{ entry: this.entry(f, false, c.length), matches }] : [];
            })
          : [
              ...[...dirs].filter((d) => d !== "/" && under(d) && name(d).includes(q)).map((d) => ({ entry: this.entry(d, true, 0), matches: [] })),
              ...[...files].filter(([f]) => under(f) && name(f).includes(q)).map(([f, c]) => ({ entry: this.entry(f, false, c.length), matches: [] })),
            ];
        const limit = b.limit || 200;
        return send(200, { results: hits.slice(0, limit), truncated: hits.length > limit, timed_out: false });
      }
      case "chmod:POST": {
        const valid = (m?: string) => !!m && /^[0-7]{3,4}$/.test(m) && (b.allow_special || m.length === 3 || m[0] === "0");
        if (!valid(b.mode) || (b.dir_mode !== undefined && !valid(b.dir_mode))) return send(400, { error: "bad_mode", message: "invalid mode" });
        for (const p of b.paths ?? []) if (!files.has(p) && !dirs.has(p)) return send(404, { error: "not_found" });
        return send(200, { changed: (b.paths ?? []).length });
      }
      default:
        return send(404, { error: "not_found" });
    }
  }

  private state(uuid: string): DaemonServerState {
    const s = this.servers.get(uuid)!;
    return { uuid, state: s.state, disk_bytes: 0, disk_exceeded: false, started_at: null, installed_at: s.installedAt };
  }
}
