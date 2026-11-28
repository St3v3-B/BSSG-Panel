/**
 * Webhook voor git-deploy: POST /api/deploy/webhook/<id>. GitHub/Gitea/Bitbucket (X-Hub-Signature-256),
 * GitLab (X-Gitlab-Token) of generiek (X-Deploy-Token / Authorization: Bearer). Alleen een push op de
 * ingestelde branch start een deploy; loopt er al een, dan volgt er daarna nog één (redeploy_pending).
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { ensureBooted } from "./boot";
import { checkWebhook, pushedBranch, startDeploy } from "./deploy";
import { getDb, schema } from "./db";
import { allowPerIp } from "./http-limits";
import { decrypt } from "./lib/crypto";
import { getLimiter } from "./lib/ratelimit";
import { fetchServerByUuid } from "./servers-data";

const MAX_BODY = 1024 * 1024;
/** Per IP (ook mislukte pogingen) en per site. */
export const WEBHOOK_LIMITS = { perIp: 60, perSite: 20, windowSeconds: 60 };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function parseBody(raw: Buffer, contentType: string): unknown {
  const text = raw.toString("utf8");
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const p = new URLSearchParams(text).get("payload");
      return p ? JSON.parse(p) : {};
    }
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export async function deployWebhook(req: Request, { params }: { params: Promise<{ hook: string }> }): Promise<Response> {
  await ensureBooted();
  if (!(await allowPerIp(req, "deploy-webhook", WEBHOOK_LIMITS.perIp, WEBHOOK_LIMITS.windowSeconds))) return json(429, { error: "rate_limited" });
  const { hook } = await params;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(hook)) return json(404, { error: "not_found" });
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return json(413, { error: "too_large" });
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length > MAX_BODY) return json(413, { error: "too_large" });
  const [row] = await getDb()
    .select({ c: schema.deployConfigs, uuid: schema.servers.uuid })
    .from(schema.deployConfigs)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.deployConfigs.serverId))
    .where(eq(schema.deployConfigs.webhookId, hook));
  if (!row) return json(404, { error: "not_found" });
  const check = checkWebhook(req.headers, raw, decrypt(row.c.webhookSecretEnc));
  if (!check.ok) return json(401, { error: "invalid_signature" });
  if ((await getLimiter().hit(`deploy:hook:${row.c.serverId}`, WEBHOOK_LIMITS.windowSeconds)) > WEBHOOK_LIMITS.perSite) return json(429, { error: "rate_limited" });
  if (check.event === "ping") return json(200, { ok: true, pong: true });
  if (check.event !== "push") return json(202, { ignored: "event" });
  if (!row.c.autoDeploy) return json(202, { ignored: "auto_deploy_off" });
  const branch = pushedBranch(parseBody(raw, req.headers.get("content-type") ?? ""), check.provider, new URL(req.url).searchParams);
  if (branch === "deleted" || branch === "tag") return json(202, { ignored: branch });
  if (branch !== null && branch !== row.c.branch) return json(202, { ignored: "branch" });
  const b = await fetchServerByUuid(row.uuid);
  if (!b) return json(404, { error: "not_found" });
  if (b.server.suspendedAt) return json(409, { error: "suspended" });
  try {
    const d = await startDeploy(b, row.c, "webhook", null, null);
    return json(202, { deploy_id: d.id });
  } catch (e) {
    if (e instanceof TRPCError && e.message === "DEPLOY_RUNNING") {
      await getDb().update(schema.deployConfigs).set({ redeployPending: true }).where(eq(schema.deployConfigs.serverId, row.c.serverId));
      return json(202, { queued: true });
    }
    const msg = e instanceof TRPCError ? e.message : "internal error";
    return json(e instanceof TRPCError && e.code === "PRECONDITION_FAILED" ? 409 : 502, { error: msg.split(":")[0] });
  }
}
