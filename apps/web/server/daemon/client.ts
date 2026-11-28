/**
 * Client voor de node-daemon (packages/api/openapi.yaml). Eén instantie per node.
 * Netwerkfout of timeout → DaemonUnreachableError; HTTP-fout → DaemonHttpError.
 */
import { openAsBlob } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { DaemonChmodRequest, DaemonFileEntry, DaemonSchemas, DaemonSearchResult, DaemonRoute, DaemonRouteWithStatus, DaemonServerSpec, DaemonServerStats, DaemonServerState, DaemonStats, DaemonSystemInfo } from "@panel/api";

type DaemonBackupRequest = DaemonSchemas["BackupRequest"];
type DaemonRestoreRequest = DaemonSchemas["RestoreRequest"];

export class DaemonUnreachableError extends Error {
  constructor(readonly nodeId: number, cause: unknown) {
    super(`DAEMON_UNREACHABLE: node ${nodeId}: ${(cause as Error)?.message ?? String(cause)}`);
  }
}

export class DaemonHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface DaemonClientOptions {
  nodeId: number;
  baseUrl: string;
  token: string;
  /** Standaardtimeout per verzoek. */
  timeoutMs?: number;
}

const TRANSFER_TIMEOUT_MS = 4 * 60 * 60_000;
const transferSignal = (extra?: AbortSignal) => (extra ? AbortSignal.any([AbortSignal.timeout(TRANSFER_TIMEOUT_MS), extra]) : AbortSignal.timeout(TRANSFER_TIMEOUT_MS));

type Method = "GET" | "POST" | "PUT" | "DELETE";

export class DaemonClient {
  readonly nodeId: number;
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(o: DaemonClientOptions) {
    this.nodeId = o.nodeId;
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.token = o.token;
    this.timeoutMs = o.timeoutMs ?? 10_000;
  }

  private async request<T>(method: Method, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const text = await this.send(method, path, body === undefined ? undefined : { json: body }, timeoutMs);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Ruwe aanroep; `raw` = octet-stream-body. Geeft de responstekst terug. */
  private async send(method: Method, path: string, body: { json: unknown } | { raw: string | Uint8Array } | undefined, timeoutMs = this.timeoutMs): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body && "json" in body ? { "content-type": "application/json" } : {}),
          ...(body && "raw" in body ? { "content-type": "application/octet-stream" } : {}),
        },
        body: body ? ("json" in body ? JSON.stringify(body.json) : (body.raw as BodyInit)) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (e) {
      throw new DaemonUnreachableError(this.nodeId, e);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new DaemonUnreachableError(this.nodeId, e);
    }
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = text.slice(0, 500);
      try {
        const j = JSON.parse(text) as { error?: string; message?: string };
        if (j.error) code = j.error;
        if (j.message) message = j.message;
      } catch {
        /* geen JSON */
      }
      // Een gateway die de daemon niet bereikt (Caddy) telt als onbereikbaar.
      if ((res.status === 502 || res.status === 503 || res.status === 504) && code !== "db_unavailable") throw new DaemonUnreachableError(this.nodeId, new Error(`${res.status} ${message}`));
      throw new DaemonHttpError(res.status, code, message || code);
    }
    return text;
  }

  updateDaemon() {
    return this.request<unknown>("POST", "/api/update", undefined, 120_000);
  }
  system(timeoutMs?: number) {
    return this.request<DaemonSystemInfo>("GET", "/api/system", undefined, timeoutMs);
  }
  listServers(timeoutMs?: number) {
    return this.request<DaemonServerState[]>("GET", "/api/servers", undefined, timeoutMs);
  }
  createServer(spec: DaemonServerSpec) {
    return this.request<DaemonServerState>("POST", "/api/servers", spec, 30_000);
  }
  getServer(uuid: string, timeoutMs?: number) {
    return this.request<DaemonServerState>("GET", `/api/servers/${uuid}`, undefined, timeoutMs);
  }
  updateServer(uuid: string, spec: DaemonServerSpec) {
    return this.request<DaemonServerState>("PUT", `/api/servers/${uuid}`, spec, 30_000);
  }
  deleteServer(uuid: string) {
    return this.request<void>("DELETE", `/api/servers/${uuid}`, undefined, 60_000);
  }
  updateServerImage(uuid: string) {
    return this.request<void>("POST", `/api/servers/${uuid}/image-update`, undefined, 30_000);
  }
  /** Alleen lokale node: git-status + laatste upgrade-run. `fetch=false` slaat `git fetch` over. */
  getPanelUpgradeStatus(fetch = true) {
    return this.request<DaemonSchemas["PanelUpgradeStatus"]>("GET", `/api/panel-upgrade/status?fetch=${fetch ? 1 : 0}`, undefined, 70_000);
  }
  startPanelUpgrade(ref?: string) {
    return this.request<{ unit: string; started_at: string }>("POST", "/api/panel-upgrade", ref ? { ref } : {}, 20_000);
  }
  checkImages() {
    return this.request<void>("POST", "/api/images/check", undefined, 15_000);
  }
  reinstall(uuid: string) {
    return this.request<void>("POST", `/api/servers/${uuid}/install`, undefined, 30_000);
  }
  power(uuid: string, action: "start" | "stop" | "restart" | "kill") {
    return this.request<void>("POST", `/api/servers/${uuid}/power`, { action });
  }
  sendCommands(uuid: string, commands: string[]) {
    return this.request<void>("POST", `/api/servers/${uuid}/commands`, { commands });
  }
  /** Command in the running site container (uid 1000, via `sh -c`). Returns also on non-zero exit or timeout. */
  exec(uuid: string, command: string, timeoutSeconds = 60) {
    return this.request<{ exit_code: number; output: string; truncated: boolean; timed_out: boolean; duration_ms: number }>("POST", `/api/servers/${uuid}/exec`, { command, timeout_seconds: timeoutSeconds }, (timeoutSeconds + 15) * 1000);
  }
  /** Velocity-netwerk: proxy + deze backends delen panel-net-<proxy>. 404 bij een oude daemon. */
  setProxyNetwork(uuid: string, members: string[]) {
    return this.request<DaemonSchemas["ProxyNetwork"]>("PUT", `/api/servers/${uuid}/network`, { members }, 30_000);
  }
  stats(uuid: string, timeoutMs?: number) {
    return this.request<DaemonStats>("GET", `/api/servers/${uuid}/stats`, undefined, timeoutMs);
  }

  /** Alle draaiende servers in één keer (404 bij een oudere daemon). */
  allStats(timeoutMs?: number) {
    return this.request<{ servers: DaemonServerStats[] }>("GET", "/api/stats", undefined, timeoutMs);
  }
  /** Server-list-ping via de daemon (statuspagina); lege velden = geen antwoord. */
  players(uuid: string, timeoutMs = 3000) {
    return this.request<{ online: number | null; max: number | null; version?: string | null; sample?: Array<{ name: string; id: string }> }>("GET", `/api/servers/${uuid}/players`, undefined, timeoutMs);
  }
  logs(uuid: string, lines = 100) {
    return this.request<{ lines: string[] }>("GET", `/api/servers/${uuid}/logs?lines=${lines}`);
  }

  // ---------- bestanden ----------
  listFiles(uuid: string, path: string) {
    return this.request<DaemonFileEntry[]>("GET", `/api/servers/${uuid}/files/list?path=${encodeURIComponent(path)}`);
  }
  readFile(uuid: string, path: string) {
    return this.send("GET", `/api/servers/${uuid}/files/contents?path=${encodeURIComponent(path)}`, undefined, 30_000);
  }
  /** Binair lezen (max 5 MB, de limiet van de daemon). */
  async readFileBytes(uuid: string, path: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/servers/${uuid}/files/contents?path=${encodeURIComponent(path)}`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(30_000),
        cache: "no-store",
      });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      throw new DaemonUnreachableError(this.nodeId, e);
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) throw new DaemonUnreachableError(this.nodeId, new Error(String(res.status)));
    throw new DaemonHttpError(res.status, `http_${res.status}`, `http_${res.status}`);
  }
  async writeFile(uuid: string, path: string, content: string | Uint8Array) {
    await this.send("PUT", `/api/servers/${uuid}/files/contents?path=${encodeURIComponent(path)}`, { raw: content }, 30_000);
  }
  mkdir(uuid: string, path: string) {
    return this.request<void>("POST", `/api/servers/${uuid}/files/mkdir`, { path });
  }
  rename(uuid: string, from: string, to: string) {
    return this.request<void>("POST", `/api/servers/${uuid}/files/rename`, { from, to });
  }
  deleteFiles(uuid: string, paths: string[]) {
    return this.request<void>("POST", `/api/servers/${uuid}/files/delete`, { paths }, 60_000);
  }
  compress(uuid: string, root: string, paths: string[]) {
    return this.request<DaemonFileEntry>("POST", `/api/servers/${uuid}/files/compress`, { root, paths }, 300_000);
  }
  decompress(uuid: string, path: string) {
    return this.request<void>("POST", `/api/servers/${uuid}/files/decompress`, { path }, 300_000);
  }
  /** Zoeken; de daemon stopt zelf na 10 s (timed_out). */
  searchFiles(uuid: string, body: { path: string; query: string; content: boolean; limit: number }) {
    return this.request<DaemonSearchResult>("POST", `/api/servers/${uuid}/files/search`, body, 30_000);
  }
  chmod(uuid: string, body: DaemonChmodRequest) {
    return this.request<{ changed: number }>("POST", `/api/servers/${uuid}/files/chmod`, body, 120_000);
  }

  /** Multipart upload of one local file to a directory of the server, with a (one-time) transfer JWT. */
  async uploadFile(uuid: string, directory: string, token: string, name: string, localFile: string, timeoutMs = 900_000): Promise<void> {
    const form = new FormData();
    form.append("files", await openAsBlob(localFile), name);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/servers/${uuid}/files/upload?${new URLSearchParams({ directory, token })}`, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    } catch (e) {
      throw new DaemonUnreachableError(this.nodeId, e);
    }
    if (!res.ok) throw await this.httpError(res);
  }

  // ---------- backups ----------
  createBackup(uuid: string, body: DaemonBackupRequest) {
    return this.request<void>("POST", `/api/servers/${uuid}/backups`, body, 30_000);
  }
  restoreBackup(uuid: string, backupId: number, body: DaemonRestoreRequest) {
    return this.request<void>("POST", `/api/servers/${uuid}/backups/${backupId}/restore`, body, 30_000);
  }
  /** Lopende backup of herstel van deze server (null = niets). */
  async backupProgress(uuid: string, timeoutMs = 3000): Promise<DaemonSchemas["BackupProgress"] | null> {
    return (await this.request<{ progress: DaemonSchemas["BackupProgress"] | null }>("GET", `/api/servers/${uuid}/backups/progress`, undefined, timeoutMs)).progress;
  }
  cancelBackup(uuid: string, backupId: number) {
    return this.request<void>("POST", `/api/servers/${uuid}/backups/${backupId}/cancel`, undefined, 10_000);
  }
  // ---------- incrementeel (restic) ----------
  createResticBackup(uuid: string, body: DaemonSchemas["ResticBackupRequest"]) {
    return this.request<void>("POST", `/api/servers/${uuid}/restic/backups`, body, 30_000);
  }
  restoreResticBackup(uuid: string, backupId: number, body: DaemonSchemas["ResticRestoreRequest"]) {
    return this.request<void>("POST", `/api/servers/${uuid}/restic/backups/${backupId}/restore`, body, 30_000);
  }
  resticLs(uuid: string, body: DaemonSchemas["ResticLsRequest"]) {
    return this.request<{ entries: DaemonSchemas["ResticEntry"][]; truncated: boolean }>("POST", `/api/servers/${uuid}/restic/ls`, body, 120_000);
  }
  resticForget(uuid: string, body: DaemonSchemas["ResticForgetRequest"]) {
    return this.request<void>("POST", `/api/servers/${uuid}/restic/forget`, body, 600_000);
  }

  // ---------- git-deploy ----------
  startDeploy(uuid: string, body: DaemonSchemas["DeployRequest"]) {
    return this.request<void>("POST", `/api/servers/${uuid}/deploy`, body, 30_000);
  }
  /** Lopende deploy van deze server (null = niets). */
  async deployProgress(uuid: string, timeoutMs = 3000): Promise<DaemonSchemas["DeployProgress"] | null> {
    return (await this.request<{ deploy: DaemonSchemas["DeployProgress"] | null }>("GET", `/api/servers/${uuid}/deploy`, undefined, timeoutMs)).deploy;
  }
  cancelDeploy(uuid: string, deployId: number) {
    return this.request<void>("POST", `/api/servers/${uuid}/deploy/${deployId}/cancel`, undefined, 10_000);
  }
  /** SSH-hostsleutels van host:port (via de node). */
  async scanGitHostKey(host: string, port: number): Promise<DaemonSchemas["GitHostKey"][]> {
    return (await this.request<{ keys: DaemonSchemas["GitHostKey"][] }>("POST", "/api/git/host-key", { host, port }, 40_000)).keys;
  }

  // ---------- verplaatsen tussen nodes ----------
  /** Tar-stroom van de hele datamap (server moet gestopt zijn). De body moet volledig gelezen worden. */
  async exportData(uuid: string, o: { live?: boolean; excludeInternal?: boolean; signal?: AbortSignal } = {}): Promise<ReadableStream<Uint8Array>> {
    let res: Response;
    const q = [o.live ? "live=1" : "", o.excludeInternal ? "exclude_internal=1" : ""].filter(Boolean).join("&");
    try {
      res = await fetch(`${this.baseUrl}/api/servers/${uuid}/transfer/export${q ? `?${q}` : ""}`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: transferSignal(o.signal),
        cache: "no-store",
      });
    } catch (e) {
      throw new DaemonUnreachableError(this.nodeId, e);
    }
    if (!res.ok || !res.body) throw await this.httpError(res);
    return res.body;
  }
  /** Pakt een tar-stroom uit in de datamap van de server. */
  async importData(uuid: string, body: ReadableStream<Uint8Array>, o: { signal?: AbortSignal } = {}): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/servers/${uuid}/transfer/import`, {
        method: "PUT",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/x-tar" },
        body,
        // @ts-expect-error duplex is verplicht voor een stream-body (Node/undici), ontbreekt in de DOM-types
        duplex: "half",
        signal: transferSignal(o.signal),
        cache: "no-store",
      });
    } catch (e) {
      throw new DaemonUnreachableError(this.nodeId, e);
    }
    if (!res.ok) throw await this.httpError(res);
    await res.arrayBuffer().catch(() => undefined);
  }

  /**
   * Kopie van de datamap van `sourceUuid` naar `uuid` op deze node (POST /transfer/copy); de data blijft op de node.
   * Oudere daemons zonder dit pad: DaemonHttpError 404 met message "unknown path".
   */
  async copyData(uuid: string, sourceUuid: string, o: { live?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/servers/${uuid}/transfer/copy`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ source_uuid: sourceUuid, live: !!o.live }),
        signal: transferSignal(o.signal),
        cache: "no-store",
      });
    } catch (e) {
      throw new DaemonUnreachableError(this.nodeId, e);
    }
    if (!res.ok) throw await this.httpError(res);
    await res.arrayBuffer().catch(() => undefined);
  }

  // ---------- publiceren (staging → productie) ----------
  private async publishFetch(uuid: string, id: number, sub: string, method: Method, body: BodyInit | undefined, contentType: string | undefined, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/servers/${uuid}/publish/${id}${sub}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(contentType ? { "content-type": contentType } : {}) },
        body,
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
        signal: transferSignal(signal),
        cache: "no-store",
      } as RequestInit);
    } catch (e) {
      throw new DaemonUnreachableError(this.nodeId, e);
    }
    if (!res.ok) throw await this.httpError(res);
    return res;
  }
  /** Tar-stroom (exportData van staging) in een lege werkmap van productie. */
  async publishData(uuid: string, id: number, body: ReadableStream<Uint8Array>, o: { signal?: AbortSignal } = {}): Promise<void> {
    await (await this.publishFetch(uuid, id, "/data", "PUT", body, "application/x-tar", o.signal)).arrayBuffer().catch(() => undefined);
  }
  /** Zelfde node: de datamap van `sourceUuid` in de werkmap. Oudere daemons: 404 "unknown path". */
  async publishCopy(uuid: string, id: number, sourceUuid: string, o: { signal?: AbortSignal } = {}): Promise<void> {
    await (await this.publishFetch(uuid, id, "/copy", "POST", JSON.stringify({ source_uuid: sourceUuid }), "application/json", o.signal)).arrayBuffer().catch(() => undefined);
  }
  /** Omwisselen (server gestopt); geeft de paden die productie hield. */
  async publishSwap(uuid: string, id: number, exclude: string[]): Promise<string[]> {
    return ((await (await this.publishFetch(uuid, id, "/swap", "POST", JSON.stringify({ exclude }), "application/json")).json()) as { log: string[] }).log;
  }
  async publishRollback(uuid: string, id: number): Promise<void> {
    await (await this.publishFetch(uuid, id, "/rollback", "POST", undefined, undefined)).arrayBuffer().catch(() => undefined);
  }
  async publishFinish(uuid: string, id: number): Promise<void> {
    await (await this.publishFetch(uuid, id, "", "DELETE", undefined, undefined)).arrayBuffer().catch(() => undefined);
  }

  private async httpError(res: Response): Promise<Error> {
    const text = await res.text().catch(() => "");
    let code = `http_${res.status}`;
    let message = text.slice(0, 500);
    try {
      const j = JSON.parse(text) as { error?: string; message?: string };
      if (j.error) code = j.error;
      if (j.message) message = j.message;
    } catch {
      /* geen JSON */
    }
    if ((res.status === 502 || res.status === 503 || res.status === 504) && code !== "db_unavailable") return new DaemonUnreachableError(this.nodeId, new Error(`${res.status} ${message}`));
    return new DaemonHttpError(res.status, code, message || code);
  }

  // ---------- databases (MariaDB van de node) ----------
  dbStatus(timeoutMs = 10_000) {
    return this.request<{ available: boolean; error?: string; host?: string }>("GET", "/api/db/status", undefined, timeoutMs);
  }
  dbCreate(name: string, username: string, password: string) {
    return this.request<void>("POST", "/api/db/databases", { name, username, password }, 30_000);
  }
  dbSetPassword(name: string, username: string, password: string) {
    return this.request<void>("PUT", `/api/db/databases/${encodeURIComponent(name)}/password`, { username, password }, 30_000);
  }
  dbDrop(name: string, username: string) {
    return this.request<void>("DELETE", `/api/db/databases/${encodeURIComponent(name)}?username=${encodeURIComponent(username)}`, undefined, 60_000);
  }
  /** phpMyAdmin-account van een panelgebruiker: wachtwoord + exact deze databases. */
  dbSyncPmaUser(username: string, password: string, databases: string[], timeoutMs = 60_000) {
    return this.request<void>("PUT", `/api/db/pma-users/${encodeURIComponent(username)}`, { password, databases }, timeoutMs);
  }
  /**
   * Databasetunnel (GET /api/db/tunnel, upgrade `panel-mariadb`): een ruwe TCP-stroom naar de MariaDB van deze
   * node. Faalt met DaemonUnreachableError (netwerk/timeout/gateway) of DaemonHttpError (bv. 503 db_unavailable).
   */
  dbTunnel(timeoutMs = 10_000): Promise<Socket> {
    const url = new URL(`${this.baseUrl}/api/db/tunnel`);
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}`, connection: "Upgrade", upgrade: "panel-mariadb" },
      timeout: timeoutMs,
    });
    return new Promise<Socket>((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(e);
      };
      const timer = setTimeout(() => fail(new DaemonUnreachableError(this.nodeId, new Error("tunnel timeout"))), timeoutMs);
      req.on("timeout", () => fail(new DaemonUnreachableError(this.nodeId, new Error("tunnel timeout"))));
      req.on("error", (e) => fail(new DaemonUnreachableError(this.nodeId, e)));
      req.on("upgrade", (res, socket, head) => {
        clearTimeout(timer);
        if (settled || res.statusCode !== 101 || String(res.headers.upgrade ?? "").toLowerCase() !== "panel-mariadb") {
          socket.destroy();
          fail(new DaemonUnreachableError(this.nodeId, new Error(`unexpected upgrade ${res.statusCode}`)));
          return;
        }
        settled = true;
        socket.setTimeout(0);
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      req.on("response", (res) => {
        clearTimeout(timer);
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text = (text + c).slice(0, 2000)));
        res.on("error", (e) => fail(new DaemonUnreachableError(this.nodeId, e)));
        res.on("end", () => {
          let code = `http_${res.statusCode}`;
          let message = text.slice(0, 500);
          try {
            const j = JSON.parse(text) as { error?: string; message?: string };
            if (j.error) code = j.error;
            if (j.message) message = j.message;
          } catch {
            /* geen JSON */
          }
          const st = res.statusCode ?? 0;
          fail((st === 502 || st === 503 || st === 504) && code !== "db_unavailable" ? new DaemonUnreachableError(this.nodeId, new Error(`${st} ${message}`)) : new DaemonHttpError(st, code, message || code));
        });
      });
      req.end();
    });
  }
  /** SQL-dump als stroom. */
  async dbDump(name: string, o: { signal?: AbortSignal } = {}): Promise<ReadableStream<Uint8Array>> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/db/databases/${encodeURIComponent(name)}/dump`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: transferSignal(o.signal),
        cache: "no-store",
      });
    } catch (e) {
      throw new DaemonUnreachableError(this.nodeId, e);
    }
    if (!res.ok || !res.body) throw await this.httpError(res);
    return res.body;
  }
  /** Laadt een SQL-stroom in een bestaande (lege) database. */
  async dbImport(name: string, body: ReadableStream<Uint8Array>, o: { signal?: AbortSignal; replace?: boolean } = {}): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/db/databases/${encodeURIComponent(name)}/import${o.replace ? "?replace=1" : ""}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/sql" },
        body,
        // @ts-expect-error duplex is verplicht voor een stream-body (Node/undici), ontbreekt in de DOM-types
        duplex: "half",
        signal: transferSignal(o.signal),
        cache: "no-store",
      });
    } catch (e) {
      throw new DaemonUnreachableError(this.nodeId, e);
    }
    if (!res.ok) throw await this.httpError(res);
    await res.arrayBuffer().catch(() => undefined);
  }

  // ---------- routes (web) ----------
  /** HTTP(S)-relay: toestand als client en als edge; `ssl` = SSL-status per hostnaam van de clients (traag). */
  relayState(ssl = false, timeoutMs?: number) {
    return this.request<DaemonSchemas["RelayState"]>("GET", `/api/relay${ssl ? "?ssl=1" : ""}`, undefined, timeoutMs);
  }
  /** Relay-config nu bij het panel ophalen. */
  relayRefresh(timeoutMs?: number) {
    return this.request<void>("POST", "/api/relay/refresh", undefined, timeoutMs);
  }
  /** Nginx Proxy Manager (HTTP_MODE=npm): toestand van de koppeling. */
  npmState(timeoutMs?: number) {
    return this.request<DaemonSchemas["NpmState"]>("GET", "/api/npm", undefined, timeoutMs);
  }
  /** NPM-instellingen nu bij het panel ophalen (501 buiten HTTP_MODE=npm). */
  npmRefresh(timeoutMs?: number) {
    return this.request<void>("POST", "/api/npm/refresh", undefined, timeoutMs);
  }
  /** Inloggen bij NPM vanaf de node; wijzigt niets. */
  npmTest(body: { url: string; email: string; password: string }, timeoutMs = 25_000) {
    return this.request<DaemonSchemas["NpmTestResult"]>("POST", "/api/npm/test", body, timeoutMs);
  }
  routes(timeoutMs?: number) {
    return this.request<DaemonRouteWithStatus[]>("GET", "/api/routes", undefined, timeoutMs);
  }
  putRoute(route: DaemonRoute) {
    return this.request<DaemonRouteWithStatus>("PUT", `/api/routes/${encodeURIComponent(route.host)}`, route, 30_000);
  }
  deleteRoute(host: string) {
    return this.request<void>("DELETE", `/api/routes/${encodeURIComponent(host)}`, undefined, 30_000);
  }
}
