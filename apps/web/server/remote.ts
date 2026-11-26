/**
 * Remote-API (daemon → panel, packages/api/panel-remote.yaml).
 * Authenticatie: Bearer <node-token>; de node wordt gevonden via sha256(token).
 */
import type { ServerStatus } from "@panel/api";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { logActivity } from "./activity";
import { ensureBooted } from "./boot";
import { getDb, schema } from "./db";
import { sha256 } from "./lib/crypto";
import { jwks } from "./lib/jwt";

type NodeRow = typeof schema.nodes.$inferSelect;

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export const error = (status: number, code: string, message?: string) => json(status, { error: code, ...(message ? { message } : {}) });
export const noContent = () => new Response(null, { status: 204 });

export async function authenticateNode(req: Request): Promise<NodeRow | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const [node] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.tokenHash, sha256(m[1]!)));
  return node ?? null;
}

/** Wrapper: boot afwachten, node authenticeren, fouten als JSON. */
export function remoteHandler<P>(fn: (req: Request, node: NodeRow, params: P) => Promise<Response>) {
  return async (req: Request, ctx: { params: Promise<P> }): Promise<Response> => {
    try {
      await ensureBooted();
      const node = await authenticateNode(req);
      if (!node) return error(401, "unauthorized", "onbekend node-token");
      return await fn(req, node, await ctx.params);
    } catch (e) {
      console.error(`[remote] ${new URL(req.url).pathname}:`, e);
      return error(500, "internal");
    }
  };
}

async function body<T extends z.ZodType>(req: Request, s: T): Promise<z.output<T> | null> {
  try {
    const r = s.safeParse(await req.json());
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const Uuid = z.string().uuid();
const DaemonState = z.enum(["installing", "install_failed", "offline", "starting", "online", "stopping", "disk_exceeded"]);

async function serverOnNode(uuid: string, node: NodeRow) {
  if (!Uuid.safeParse(uuid).success) return null;
  const [s] = await getDb()
    .select()
    .from(schema.servers)
    .where(and(eq(schema.servers.uuid, uuid), eq(schema.servers.nodeId, node.id)));
  return s ?? null;
}

// ---------- handlers ----------

export const getJwtKey = remoteHandler(async () => json(200, await jwks()));

export const nodeHello = remoteHandler(async (req, node) => {
  const b = await body(req, z.object({ version: z.string().max(100), disk_quota_mode: z.enum(["soft", "xfs"]) }));
  if (!b) return error(400, "bad_request");
  await getDb().update(schema.nodes).set({ daemonVersion: b.version, diskQuotaMode: b.disk_quota_mode, lastSeenAt: new Date() }).where(eq(schema.nodes.id, node.id));
  return noContent();
});

export const reportInstall = remoteHandler<{ uuid: string }>(async (req, node, { uuid }) => {
  const b = await body(req, z.object({ successful: z.boolean(), error: z.string().nullish() }));
  if (!b) return error(400, "bad_request");
  const s = await serverOnNode(uuid, node);
  if (!s) return error(404, "not_found");
  // Starten na de installatie doet de daemon zelf (start_on_install in de spec).
  await getDb()
    .update(schema.servers)
    .set(b.successful ? { installedAt: new Date(), status: s.status === "installing" || s.status === "install_failed" ? "offline" : s.status } : { status: "install_failed" })
    .where(eq(schema.servers.id, s.id));
  await logActivity({
    action: b.successful ? "server.install.completed" : "server.install.failed",
    serverId: s.id,
    metadata: b.successful ? {} : { error: b.error?.slice(0, 2000) ?? null },
  });
  return noContent();
});

export const reportStatus = remoteHandler<{ uuid: string }>(async (req, node, { uuid }) => {
  const b = await body(req, z.object({ state: DaemonState }));
  if (!b) return error(400, "bad_request");
  const s = await serverOnNode(uuid, node);
  if (!s) return error(404, "not_found");
  await getDb().update(schema.servers).set({ status: b.state as ServerStatus }).where(eq(schema.servers.id, s.id));
  return noContent();
});
