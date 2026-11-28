/**
 * Nep-Pterodactyl/Pelican voor tests: Application API + Client API (backups) over node:http, en een
 * alleen-lezen Wings-SFTP (ssh2-server) met een bestandsboom in het geheugen. Alles luistert op 127.0.0.1
 * met een willekeurige poort. Elke aanroep wordt vastgelegd, zodat tests kunnen controleren dat de bron
 * alleen gelezen wordt (geen POST/PUT/DELETE, geen SFTP-schrijfacties).
 */
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import ssh2 from "ssh2";
import { tarStream, type TarEntry } from "../importer/tar";

type Obj = Record<string, unknown>;
const listOf = (object: string, items: Obj[], page: number, perPage: number) => {
  const total = Math.max(1, Math.ceil(items.length / perPage));
  return {
    object: "list",
    data: items.slice((page - 1) * perPage, page * perPage).map((a) => ({ object, attributes: a })),
    meta: { pagination: { total: items.length, count: Math.min(perPage, items.length), per_page: perPage, current_page: page, total_pages: total, links: {} } },
  };
};

export interface FakeTree {
  files: Map<string, Buffer>;
  dirs: Set<string>;
}

export async function tarGz(tree: FakeTree): Promise<Buffer> {
  async function* entries(): AsyncGenerator<TarEntry> {
    for (const d of [...tree.dirs].sort()) yield { type: "dir", path: d };
    for (const [p, c] of tree.files) yield { type: "file", path: p, size: c.length, open: async function* () { yield c; } };
  }
  const chunks: Uint8Array[] = [];
  const reader = tarStream(entries()).getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
  }
  return gzipSync(Buffer.concat(chunks));
}

export class FakePtero {
  kind: "pterodactyl" | "pelican" = "pterodactyl";
  appKey = "ptla_testkey_application";
  clientKey = "ptlc_testkey_client";
  /** Server-side maximum per pagina (om paginering te testen). */
  perPageCap = 2;
  readonly requests: Array<{ method: string; path: string; auth: string | undefined }> = [];
  users: Obj[] = [];
  nodes: Obj[] = [];
  nests: Array<{ id: number; name: string; eggs: Obj[] }> = [];
  servers: Obj[] = [];
  /** identifier → backups (attributes) */
  backups = new Map<string, Obj[]>();
  /** backup-uuid → tar.gz */
  backupFiles = new Map<string, Buffer>();
  /** identifier → bestandsboom voor SFTP */
  trees = new Map<string, FakeTree>();
  sftpUser = "steve";
  sftpPassword = "geheim-wachtwoord";
  readonly sftpOps: string[] = [];
  private http: HttpServer | null = null;
  private ssh: ssh2.Server | null = null;
  url = "";
  sftpPort = 0;

  async start(): Promise<void> {
    this.http = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      this.requests.push({ method: req.method ?? "GET", path: u.pathname + u.search, auth: req.headers.authorization });
      const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.method !== "GET") return json(405, { errors: [{ code: "MethodNotAllowed" }] });
      const dl = /^\/download\/([0-9a-f-]+)$/.exec(u.pathname);
      if (dl) {
        const f = this.backupFiles.get(dl[1]!);
        if (!f || u.searchParams.get("token") !== "signed") return json(403, {});
        return res.writeHead(200, { "content-type": "application/gzip" }).end(f);
      }
      const page = Number(u.searchParams.get("page") ?? 1);
      const per = Math.min(Number(u.searchParams.get("per_page") ?? 50), this.perPageCap);
      const p = u.pathname;
      if (p.startsWith("/api/client/")) {
        if (req.headers.authorization !== `Bearer ${this.clientKey}`) return json(401, { errors: [{ code: "AuthenticationException" }] });
        const bm = /^\/api\/client\/servers\/([a-z0-9]+)\/backups(?:\/([0-9a-f-]+)\/download)?$/.exec(p);
        if (!bm) return json(404, {});
        if (bm[2]) return json(200, { object: "signed_url", attributes: { url: `${this.url}/download/${bm[2]}?token=signed` } });
        return json(200, listOf("backup", this.backups.get(bm[1]!) ?? [], page, per));
      }
      if (!p.startsWith("/api/application/")) return res.writeHead(200, { "content-type": "text/html" }).end("<html>panel</html>");
      if (req.headers.authorization !== `Bearer ${this.appKey}`) return json(401, { errors: [{ code: "AuthenticationException" }] });
      const include = (u.searchParams.get("include") ?? "").split(",");
      const eggOut = (e: Obj) => (include.includes("variables") ? e : { ...e, relationships: undefined });
      if (p === "/api/application/users") return json(200, listOf("user", this.users, page, per));
      if (p === "/api/application/nodes") return json(200, listOf("node", this.nodes, page, per));
      if (p === "/api/application/nests" && this.kind === "pterodactyl") return json(200, listOf("nest", this.nests.map((n) => ({ id: n.id, name: n.name })), page, per));
      const ne = /^\/api\/application\/nests\/(\d+)\/eggs$/.exec(p);
      if (ne && this.kind === "pterodactyl") return json(200, listOf("egg", (this.nests.find((n) => n.id === Number(ne[1]))?.eggs ?? []).map(eggOut), page, per));
      if (p === "/api/application/eggs" && this.kind === "pelican") return json(200, listOf("egg", this.nests.flatMap((n) => n.eggs).map(eggOut), page, per));
      if (p === "/api/application/servers") {
        const items = this.servers.map((s) => {
          const rel = s.relationships as Obj;
          return { ...s, relationships: Object.fromEntries(Object.entries(rel).filter(([k]) => include.includes(k))) };
        });
        return json(200, listOf("server", items, page, per));
      }
      return json(404, { errors: [{ code: "NotFoundHttpException" }] });
    });
    await new Promise<void>((r) => this.http!.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;

    const hostKey = ssh2.utils.generateKeyPairSync("ed25519").private;
    const { STATUS_CODE, OPEN_MODE } = ssh2.utils.sftp;
    this.ssh = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      let tree: FakeTree | null = null;
      client.on("authentication", (ctx) => {
        const m = /^(.+)\.([a-z0-9]{8})$/.exec(ctx.username);
        if (ctx.method === "password" && m && m[1] === this.sftpUser && ctx.password === this.sftpPassword && this.trees.has(m[2]!)) {
          tree = this.trees.get(m[2]!)!;
          return ctx.accept();
        }
        return ctx.reject(["password"]);
      });
      client.on("error", () => undefined);
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp();
            const t = tree!;
            const handles = new Map<number, { kind: "dir"; path: string; done: boolean } | { kind: "file"; path: string }>();
            let next = 1;
            const h = (n: number) => {
              const b = Buffer.alloc(4);
              b.writeUInt32BE(n);
              return b;
            };
            const id = (b: Buffer) => b.readUInt32BE(0);
            const norm = (p: string) => ("/" + p.split("/").filter((x) => x && x !== ".").join("/")).replace(/\/+$/, "") || "/";
            const now = Math.floor(Date.now() / 1000);
            const attrsOf = (p: string) => {
              const f = t.files.get(p);
              if (f) return { mode: 0o100644, uid: 1000, gid: 1000, size: f.length, atime: now, mtime: now };
              if (p === "/" || t.dirs.has(p)) return { mode: 0o040755, uid: 1000, gid: 1000, size: 4096, atime: now, mtime: now };
              return null;
            };
            const deny = (op: string) => (reqid: number) => {
              this.sftpOps.push(op);
              sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
            };
            for (const op of ["WRITE", "REMOVE", "RMDIR", "MKDIR", "RENAME", "SETSTAT", "FSETSTAT", "SYMLINK"] as const) sftp.on(op, deny(op) as never);
            sftp.on("REALPATH", (reqid, path) => {
              this.sftpOps.push("REALPATH");
              const p = norm(path);
              sftp.name(reqid, [{ filename: p, longname: p, attrs: attrsOf(p) ?? { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 } }]);
            });
            const stat = (reqid: number, path: string) => {
              this.sftpOps.push("STAT");
              const a = attrsOf(norm(path));
              return a ? sftp.attrs(reqid, a) : sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            };
            sftp.on("STAT", stat);
            sftp.on("LSTAT", stat);
            sftp.on("OPENDIR", (reqid, path) => {
              this.sftpOps.push("OPENDIR");
              const p = norm(path);
              if (!(p === "/" || t.dirs.has(p))) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              const n = next++;
              handles.set(n, { kind: "dir", path: p, done: false });
              sftp.handle(reqid, h(n));
            });
            sftp.on("READDIR", (reqid, handle) => {
              this.sftpOps.push("READDIR");
              const x = handles.get(id(handle));
              if (!x || x.kind !== "dir") return sftp.status(reqid, STATUS_CODE.FAILURE);
              if (x.done) return sftp.status(reqid, STATUS_CODE.EOF);
              x.done = true;
              const pre = x.path === "/" ? "/" : `${x.path}/`;
              const children = [...new Set([...t.dirs, ...t.files.keys()].filter((q) => q.startsWith(pre) && !q.slice(pre.length).includes("/") && q !== x.path))];
              sftp.name(reqid, children.map((c) => ({ filename: c.slice(pre.length), longname: c.slice(pre.length), attrs: attrsOf(c)! })));
            });
            sftp.on("OPEN", (reqid, path, flags) => {
              this.sftpOps.push("OPEN");
              if (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC)) {
                this.sftpOps.push("OPEN_WRITE");
                return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
              }
              const p = norm(path);
              if (!t.files.has(p)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              const n = next++;
              handles.set(n, { kind: "file", path: p });
              sftp.handle(reqid, h(n));
            });
            sftp.on("READ", (reqid, handle, offset, length) => {
              const x = handles.get(id(handle));
              if (!x || x.kind !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
              const f = t.files.get(x.path)!;
              if (offset >= f.length) return sftp.status(reqid, STATUS_CODE.EOF);
              sftp.data(reqid, f.subarray(offset, Math.min(f.length, offset + length)));
            });
            sftp.on("FSTAT", (reqid, handle) => {
              const x = handles.get(id(handle));
              const a = x ? attrsOf(x.path) : null;
              return a ? sftp.attrs(reqid, a) : sftp.status(reqid, STATUS_CODE.FAILURE);
            });
            sftp.on("CLOSE", (reqid, handle) => {
              handles.delete(id(handle));
              sftp.status(reqid, STATUS_CODE.OK);
            });
          });
        });
      });
    });
    await new Promise<void>((r) => this.ssh!.listen(0, "127.0.0.1", () => r()));
    this.sftpPort = (this.ssh.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
    await new Promise<void>((r) => (this.ssh ? this.ssh.close(() => r()) : r()));
  }

  /** Verzoeken die iets anders dan lezen deden (moet leeg blijven). */
  writes(): string[] {
    return [...this.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`), ...this.sftpOps.filter((o) => !["REALPATH", "STAT", "OPENDIR", "READDIR", "OPEN"].includes(o))];
  }

  /** Realistische dataset: 3 gebruikers, 1 node, 2 nests (Paper + Teamspeak), 3 servers. */
  seed(): void {
    this.users = [
      { id: 1, external_id: "291500000000000001", uuid: "u-1", username: "steve", email: "steve@panel.test", first_name: "Steve", last_name: "B", language: "en", root_admin: true, "2fa": false },
      { id: 2, external_id: null, uuid: "u-2", username: "kees", email: "kees@panel.test", first_name: "Kees", last_name: "", language: "nl", root_admin: false, "2fa": false },
      { id: 3, external_id: null, uuid: "u-3", username: "zonderdiscord", email: "nobody@panel.test", first_name: "", last_name: "", language: "en", root_admin: false, "2fa": false },
    ];
    this.nodes = [{ id: 5, uuid: "n-5", public: true, name: "Wings NL", fqdn: "wings.node1.test", scheme: "https", behind_proxy: false, maintenance_mode: false, memory: 16384, disk: 200000, daemon_listen: 8080, daemon_sftp: 2022, daemon_base: "/var/lib/pterodactyl/volumes" }];
    const variable = (id: number, egg: number, env: string, def: string, rules: string, name = env) => ({ object: "egg_variable", attributes: { id, egg_id: egg, name, description: `${name} description`, env_variable: env, default_value: def, user_viewable: true, user_editable: true, rules } });
    this.nests = [
      {
        id: 1,
        name: "Minecraft",
        eggs: [
          {
            id: 3,
            uuid: "e-3",
            name: "Testspel",
            nest: 1,
            author: "support@pterodactyl.io",
            description: "Game egg that matches the test template",
            docker_image: "ghcr.io/pterodactyl/yolks:java_21",
            docker_images: { "Java 21": "example/game:1" },
            config: { files: { "server.properties": { parser: "properties", find: { "server-ip": "0.0.0.0", "server-port": "{{server.build.default.port}}" } } }, startup: { done: ")! For help, type " }, stop: "stop", logs: {}, extends: null },
            startup: "java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{JAR_FILE}}",
            script: { privileged: true, install: "#!/bin/bash\ncd /mnt/server\ncurl -o server.jar https://example.invalid/paper.jar", entry: "bash", container: "ghcr.io/pterodactyl/installers:alpine", extends: null },
            relationships: { variables: { object: "list", data: [variable(10, 3, "JAR_FILE", "server.jar", "required|string|max:20", "Server Jar File"), variable(11, 3, "BUILD_NUMBER", "latest", "required|string|max:20", "Build Number")] } },
          },
        ],
      },
      {
        id: 2,
        name: "Voice Servers",
        eggs: [
          {
            id: 7,
            uuid: "e-7",
            name: "Teamspeak3 Server",
            nest: 2,
            author: "support@pterodactyl.io",
            description: "VoIP software",
            docker_image: "ghcr.io/parkervcp/yolks:debian",
            docker_images: { Debian: "ghcr.io/parkervcp/yolks:debian" },
            config: { files: { "ts3server.ini": { parser: "ini", find: { default_voice_port: "{{server.build.default.port}}" } } }, startup: { done: "listening on 0.0.0.0:" }, stop: "^C", logs: {}, extends: null },
            startup: "./ts3server default_voice_port={{SERVER_PORT}} query_port={{QUERY_PORT}} license_accepted=1",
            script: { privileged: true, install: "#!/bin/ash\ncd /mnt/server\nwget https://example.invalid/ts3.tar.bz2", entry: "ash", container: "ghcr.io/pterodactyl/installers:alpine", extends: null },
            relationships: { variables: { object: "list", data: [variable(20, 7, "QUERY_PORT", "10011", "required|integer|between:1025,65535", "Query Port"), variable(21, 7, "TS_VERSION", "latest", "required|string|max:20", "Server Version")] } },
          },
        ],
      },
    ];
    const server = (id: number, ident: string, name: string, user: number, egg: number, port: number, vars: Array<[string, string]>, memory = 1024) => ({
      id,
      external_id: null,
      uuid: `${ident}-0000-4000-8000-00000000000${id}`,
      identifier: ident,
      name,
      description: "",
      status: null,
      suspended: false,
      limits: { memory, swap: 0, disk: 5000, io: 500, cpu: 150, threads: null, oom_disabled: true },
      feature_limits: { databases: 0, allocations: 1, backups: 2 },
      user,
      node: 5,
      allocation: 100 + id,
      nest: egg === 3 ? 1 : 2,
      egg,
      container: { startup_command: "java -jar server.jar", image: "ghcr.io/pterodactyl/yolks:java_21", installed: 1, environment: Object.fromEntries([...vars, ["STARTUP", "java"], ["P_SERVER_LOCATION", "NL"], ["P_SERVER_UUID", "x"]]) },
      relationships: {
        allocations: { object: "list", data: [{ object: "allocation", attributes: { id: 100 + id, ip: "203.0.113.5", alias: null, port, notes: null, assigned: true } }] },
        variables: { object: "list", data: vars.map(([k, v], i) => ({ object: "server_variable", attributes: { id: i, egg_id: egg, name: k, description: "", env_variable: k, default_value: "x", user_viewable: true, user_editable: true, rules: "required", server_value: v } })) },
      },
    });
    this.servers = [
      server(1, "a1b2c3d4", "Survival", 1, 3, 25565, [["JAR_FILE", "paper.jar"], ["BUILD_NUMBER", "120"]], 0),
      server(2, "b2c3d4e5", "Creatief", 2, 3, 25566, [["JAR_FILE", "server.jar"]]),
      server(3, "c3d4e5f6", "TS3", 2, 7, 9987, [["QUERY_PORT", "10011"]]),
    ];
  }
}
