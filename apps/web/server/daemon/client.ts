/**
 * Client voor de node-daemon (packages/api/openapi.yaml). Eén instantie per node.
 * Netwerkfout of timeout → DaemonUnreachableError; HTTP-fout → DaemonHttpError.
 */
import type { DaemonFileEntry, DaemonRoute, DaemonRouteWithStatus, DaemonServerSpec, DaemonServerState, DaemonStats, DaemonSystemInfo } from "@panel/api";

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
  private async send(method: Method, path: string, body: { json: unknown } | { raw: string } | undefined, timeoutMs = this.timeoutMs): Promise<string> {
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
        body: body ? ("json" in body ? JSON.stringify(body.json) : body.raw) : undefined,
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
      if (res.status === 502 || res.status === 503 || res.status === 504) throw new DaemonUnreachableError(this.nodeId, new Error(`${res.status} ${message}`));
      throw new DaemonHttpError(res.status, code, message || code);
    }
    return text;
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
  reinstall(uuid: string) {
    return this.request<void>("POST", `/api/servers/${uuid}/install`, undefined, 30_000);
  }
  power(uuid: string, action: "start" | "stop" | "restart" | "kill") {
    return this.request<void>("POST", `/api/servers/${uuid}/power`, { action });
  }
  sendCommands(uuid: string, commands: string[]) {
    return this.request<void>("POST", `/api/servers/${uuid}/commands`, { commands });
  }
  stats(uuid: string, timeoutMs?: number) {
    return this.request<DaemonStats>("GET", `/api/servers/${uuid}/stats`, undefined, timeoutMs);
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
  async writeFile(uuid: string, path: string, content: string) {
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

  // ---------- verplaatsen tussen nodes ----------
  /** Tar-stroom van de hele datamap (server moet gestopt zijn). De body moet volledig gelezen worden. */
  async exportData(uuid: string): Promise<ReadableStream<Uint8Array>> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/servers/${uuid}/transfer/export`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (e) {
      throw new DaemonUnreachableError(this.nodeId, e);
    }
    if (!res.ok || !res.body) throw await this.httpError(res);
    return res.body;
  }
  /** Pakt een tar-stroom uit in de datamap van de server. */
  async importData(uuid: string, body: ReadableStream<Uint8Array>): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/servers/${uuid}/transfer/import`, {
        method: "PUT",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/x-tar" },
        body,
        // @ts-expect-error duplex is verplicht voor een stream-body (Node/undici), ontbreekt in de DOM-types
        duplex: "half",
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (e) {
      throw new DaemonUnreachableError(this.nodeId, e);
    }
    if (!res.ok) throw await this.httpError(res);
    await res.arrayBuffer().catch(() => undefined);
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
    if (res.status === 502 || res.status === 503 || res.status === 504) return new DaemonUnreachableError(this.nodeId, new Error(`${res.status} ${message}`));
    return new DaemonHttpError(res.status, code, message || code);
  }

  // ---------- routes (web) ----------
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
