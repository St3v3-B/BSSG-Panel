/** HTTP-handlers van de node-join: /join, /join/daemon/<arch>, /api/join/{exchange,progress}, /api/remote/acme/dns. */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join as pjoin, resolve } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { ensureBooted } from "./boot";
import { acmeDns, exchangeJoinCode, IPV4, JOIN_STATES, reportProgress } from "./join";
import { getLimiter } from "./lib/ratelimit";
import { error, json, noContent, remoteHandler } from "./remote";
import { publicPanelUrl } from "./routers/nodes";

/** Map met join.sh en de daemon-binaries (in de image: /app/join, gebouwd uit dezelfde commit). */
export function joinAssetsDir(): string {
  if (process.env.JOIN_ASSETS_DIR) return process.env.JOIN_ASSETS_DIR;
  for (const c of ["/app/join", resolve(process.cwd(), "../../deploy/join"), resolve(process.cwd(), "deploy/join")]) if (existsSync(pjoin(c, "join.sh"))) return c;
  return "/app/join";
}

const text = (status: number, body: string, type = "text/plain; charset=utf-8") => new Response(body, { status, headers: { "content-type": type, "cache-control": "no-store" } });

/** GET /join: het statische script; alleen de panel-URL (geen geheim) wordt ingevuld. */
export async function getJoinScript(): Promise<Response> {
  const f = pjoin(joinAssetsDir(), "join.sh");
  if (!existsSync(f)) return text(404, "join script not available\n");
  return text(200, readFileSync(f, "utf8").replaceAll("__PANEL_URL__", publicPanelUrl()));
}

/** GET /join/daemon/<arch> en /join/daemon/<arch>.sha256 */
export async function getJoinDaemon(_req: Request, ctx: { params: Promise<{ arch: string }> }): Promise<Response> {
  const { arch: raw } = await ctx.params;
  const m = /^(amd64|arm64)(\.sha256)?$/.exec(raw);
  if (!m) return text(404, "unknown architecture\n");
  const f = pjoin(joinAssetsDir(), `panel-daemon-linux-${m[1]}${m[2] ?? ""}`);
  if (!existsSync(f)) return text(404, "daemon binary not available\n");
  if (m[2]) return text(200, readFileSync(f, "utf8"));
  return new Response(Readable.toWeb(createReadStream(f)) as ReadableStream, {
    headers: { "content-type": "application/octet-stream", "content-length": String(statSync(f).size), "cache-control": "no-store" },
  });
}

/** GET /join/files.tar.gz en .sha256: compose-bestand, Caddy-build en systemd-unit voor de node. */
export async function getJoinFiles(_req: Request, ctx: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await ctx.params;
  if (file !== "files.tar.gz" && file !== "files.tar.gz.sha256") return text(404, "not found\n");
  const f = pjoin(joinAssetsDir(), `node-${file}`);
  if (!existsSync(f)) return text(404, "node files not available\n");
  return file.endsWith(".sha256")
    ? text(200, readFileSync(f, "utf8"))
    : new Response(Readable.toWeb(createReadStream(f)) as ReadableStream, { headers: { "content-type": "application/gzip", "cache-control": "no-store" } });
}

const clientIp = (req: Request) => (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "unknown").trim();

export async function joinExchange(req: Request): Promise<Response> {
  try {
    await ensureBooted();
    const hits = await getLimiter().hit(`join-exchange:${clientIp(req)}`, 600);
    if (hits > 20) return error(429, "too_many_attempts");
    const r = z.object({ code: z.string().min(16).max(200), ip: z.string().regex(IPV4) }).safeParse(await req.json().catch(() => null));
    if (!r.success) return error(400, "bad_request");
    const out = await exchangeJoinCode(r.data.code, r.data.ip);
    return out ? json(200, out) : error(404, "invalid_code");
  } catch (e) {
    console.error("[join] exchange:", e);
    return error(500, "internal");
  }
}

export const joinProgress = remoteHandler(async (req, node) => {
  const r = z.object({ state: z.enum(JOIN_STATES), message: z.string().max(500).optional() }).safeParse(await req.json().catch(() => null));
  if (!r.success) return error(400, "bad_request");
  await reportProgress(node, r.data.state, r.data.message ?? null);
  return noContent();
});

export const acmeDnsHandler = remoteHandler(async (req, node) => {
  const r = z.object({ action: z.enum(["present", "cleanup"]), value: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/) }).safeParse(await req.json().catch(() => null));
  if (!r.success) return error(400, "bad_request");
  const res = await acmeDns(node, r.data.action, r.data.value).catch((e) => {
    console.error("[acme-dns]", e);
    return "error" as const;
  });
  if (res === "forbidden") return error(403, "forbidden", "this node serves domains through Caddy");
  if (res === "no_provider") return error(400, "no_provider", "no Cloudflare zone covers this node domain");
  if (res === "error") return error(502, "dns_failed");
  return noContent();
});
