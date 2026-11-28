/**
 * Openbare REST-API (`/api/v1/...`) bovenop dezelfde tRPC-procedures: zelfde rechten, zelfde validatie.
 * Puur (geen DB): gedeeld door de handler en het OpenAPI-document (dat ook in mock-modus werkt).
 */
import { contract, FilePath, PowerAction, Uuid, type Permission } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface RestInputParts {
  params: Record<string, string>;
  query: URLSearchParams;
  /** JSON-body (geparsed) of, bij `bodyKind: "text"`, de ruwe tekst. */
  body: unknown;
}

export interface RestRoute {
  method: Method;
  /** Pad onder /api/v1 met `{param}`-delen. */
  path: string;
  operationId: string;
  tag: "account" | "servers" | "files" | "backups" | "databases";
  /** tRPC-procedure, bv. `servers.power`. */
  proc: string;
  summary: string;
  /** Recht op de server dat nodig is (naast toegang tot de server); null = alleen toegang. */
  permission: Permission | null;
  query?: z.ZodObject;
  body?: z.ZodType;
  bodyKind?: "json" | "text";
  status?: number;
  input: (p: RestInputParts) => unknown;
  /** Uitvoer van de procedure (voor het OpenAPI-document). */
  output: z.ZodType;
  /** Controle vooraf met dezelfde caller (bv. backup hoort bij de server uit het pad); gooit NOT_FOUND. */
  pre?: (call: (proc: string, input: unknown) => Promise<unknown>, p: RestInputParts) => Promise<void>;
}

const obj = (b: unknown): Record<string, unknown> => (b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {});
const q = (query: URLSearchParams, k: string, d?: string) => query.get(k) ?? d;

export const PathQuery = z.object({ path: FilePath.describe("Path relative to the server root, starting with /") });

export const REST_ROUTES: RestRoute[] = [
  {
    method: "GET", path: "/me", operationId: "getMe", tag: "account", proc: "account.get",
    summary: "The user that owns this API key", permission: null,
    input: () => undefined, output: contract.account.get.output,
  },
  {
    method: "GET", path: "/servers", operationId: "listServers", tag: "servers", proc: "servers.list",
    summary: "Servers you own or are a subuser of (only the servers of the key when it is limited)", permission: null,
    input: () => undefined, output: contract.servers.list.output,
  },
  {
    method: "GET", path: "/servers/{uuid}", operationId: "getServer", tag: "servers", proc: "servers.get",
    summary: "Server details, including your permissions on it", permission: null,
    input: ({ params }) => ({ uuid: params.uuid }), output: contract.servers.get.output,
  },
  {
    method: "GET", path: "/servers/{uuid}/stats", operationId: "getServerStats", tag: "servers", proc: "servers.stats",
    summary: "Current resource usage (null when the server is not running)", permission: "console.read",
    input: ({ params }) => ({ uuid: params.uuid }), output: contract.servers.stats.output,
  },
  {
    method: "POST", path: "/servers/{uuid}/power", operationId: "powerServer", tag: "servers", proc: "servers.power",
    summary: "Start, stop, restart or kill the server", permission: "power", status: 202,
    body: z.object({ action: PowerAction }), bodyKind: "json",
    input: ({ params, body }) => ({ uuid: params.uuid, action: obj(body).action }), output: contract.servers.power.output,
  },
  {
    method: "POST", path: "/servers/{uuid}/command", operationId: "sendCommand", tag: "servers", proc: "servers.sendCommand",
    summary: "Send a console command (one line)", permission: "console.write",
    body: z.object({ command: z.string().min(1).max(2000) }), bodyKind: "json",
    input: ({ params, body }) => ({ uuid: params.uuid, command: obj(body).command }), output: contract.servers.sendCommand.output,
  },
  {
    method: "GET", path: "/servers/{uuid}/files", operationId: "listFiles", tag: "files", proc: "files.list",
    summary: "List a directory", permission: "files.read",
    query: z.object({ path: FilePath.default("/").describe("Directory, default /") }),
    input: ({ params, query }) => ({ uuid: params.uuid, path: q(query, "path", "/") }), output: contract.files.list.output,
  },
  {
    method: "GET", path: "/servers/{uuid}/files/contents", operationId: "readFile", tag: "files", proc: "files.read",
    summary: "Read a text file (max 5 MB)", permission: "files.read", query: PathQuery,
    input: ({ params, query }) => ({ uuid: params.uuid, path: q(query, "path") }), output: contract.files.read.output,
  },
  {
    method: "PUT", path: "/servers/{uuid}/files/contents", operationId: "writeFile", tag: "files", proc: "files.write",
    summary: "Write a text file (the request body is the new content)", permission: "files.write", query: PathQuery,
    body: z.string().describe("New file content"), bodyKind: "text",
    input: ({ params, query, body }) => ({ uuid: params.uuid, path: q(query, "path"), content: typeof body === "string" ? body : "" }), output: contract.files.write.output,
  },
  {
    method: "POST", path: "/servers/{uuid}/files/delete", operationId: "deleteFiles", tag: "files", proc: "files.delete",
    summary: "Delete files or directories", permission: "files.write",
    body: z.object({ paths: z.array(FilePath).min(1) }), bodyKind: "json",
    input: ({ params, body }) => ({ uuid: params.uuid, paths: obj(body).paths }), output: contract.files.delete.output,
  },
  {
    method: "GET", path: "/servers/{uuid}/backups", operationId: "listBackups", tag: "backups", proc: "backups.list",
    summary: "List backups", permission: "backup.create",
    input: ({ params }) => ({ uuid: params.uuid }), output: contract.backups.list.output,
  },
  {
    method: "POST", path: "/servers/{uuid}/backups", operationId: "createBackup", tag: "backups", proc: "backups.create",
    summary: "Start a backup (runs in the background; poll the list for its status)", permission: "backup.create", status: 202,
    body: z.object({ name: z.string().max(100).nullable().optional(), includeDatabases: z.boolean().optional() }), bodyKind: "json",
    input: ({ params, body }) => ({ uuid: params.uuid, ...pick(obj(body), ["name", "includeDatabases"]) }), output: contract.backups.create.output,
  },
  {
    method: "POST", path: "/servers/{uuid}/backups/{id}/restore", operationId: "restoreBackup", tag: "backups", proc: "backups.restore",
    summary: "Restore a backup (overwrites the server data)", permission: "backup.restore", status: 202,
    input: ({ params }) => ({ id: Number(params.id) }), output: contract.backups.restore.output,
    pre: async (call, { params }) => {
      const list = (await call("backups.list", { uuid: params.uuid })) as Array<{ id: number }>;
      if (!list.some((b) => b.id === Number(params.id))) throw new TRPCError({ code: "NOT_FOUND", message: "BACKUP_NOT_FOUND" });
    },
  },
  {
    method: "GET", path: "/servers/{uuid}/databases", operationId: "listDatabases", tag: "databases", proc: "databases.list",
    summary: "Databases of the server, with credentials", permission: "database.manage",
    input: ({ params }) => ({ uuid: params.uuid }), output: contract.databases.list.output,
  },
];

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

/** Zoekt de route bij methode + pad (onder /api/v1). `methodNotAllowed` als alleen de methode niet past. */
export function matchRoute(method: string, path: string): { route: RestRoute; params: Record<string, string> } | { methodNotAllowed: true } | null {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  let pathMatched = false;
  for (const r of REST_ROUTES) {
    const rp = r.path.split("/").filter(Boolean);
    if (rp.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < rp.length; i++) {
      const seg = rp[i]!;
      const val = decodeURIComponent(parts[i]!);
      if (seg.startsWith("{")) params[seg.slice(1, -1)] = val;
      else if (seg !== val) ok = false;
    }
    if (!ok) continue;
    if (params.uuid !== undefined && !Uuid.safeParse(params.uuid).success) continue;
    if (params.id !== undefined && !/^\d{1,12}$/.test(params.id)) continue;
    pathMatched = true;
    if (r.method === method) return { route: r, params };
  }
  return pathMatched ? { methodNotAllowed: true } : null;
}
