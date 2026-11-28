/**
 * REST-handler voor /api/v1: zoekt de route, roept dezelfde tRPC-procedure aan (met de API-sleutel als
 * login) en vertaalt het resultaat naar JSON. Alleen `Authorization: Bearer <api-sleutel>`: cookies tellen
 * hier niet mee, zodat een andere site niets namens een ingelogde browser kan doen (geen CSRF).
 */
import type { AnyRouter } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { createCallerFactory, type Ctx } from "@panel/api";
import { apiKeyOf, bearerFrom, limitApiKey, loadApiKeySession } from "../apikey";
import { ensureBooted } from "../boot";
import { allowPerIp } from "../http-limits";
import { clientIp } from "../login";
import { buildOpenApi } from "./openapi";
import { matchRoute } from "./routes";

export const REST_PREFIX = "/api/v1";
/** Mislukte sleutels per IP per minuut voordat we 429 geven (tegen raden). */
export const BAD_KEY_PER_IP = 30;
const MAX_BODY = 6 * 1024 * 1024;

/** Context voor REST: uitsluitend een API-sleutel. */
export async function restContext(req: Request, resHeaders: Headers): Promise<Ctx> {
  await ensureBooted();
  const bearer = bearerFrom(req);
  let session = null;
  if (bearer) {
    session = await loadApiKeySession(bearer, resHeaders);
    if (!session && !(await allowPerIp(req, "apikey-bad", BAD_KEY_PER_IP, 60))) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "RATE_LIMITED" });
    const key = session ? apiKeyOf({ session, ip: null, userAgent: null, resHeaders }) : null;
    if (key) await limitApiKey(key);
  }
  return { session, ip: clientIp(req), userAgent: req.headers.get("user-agent"), resHeaders };
}

export interface RestDeps {
  router: AnyRouter;
  context: (req: Request, resHeaders: Headers) => Promise<Ctx>;
  /** Voor de `servers` in het OpenAPI-document (standaard de origin van het verzoek). */
  baseUrl?: string;
}

const json = (status: number, body: unknown, headers?: Headers) => {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: h });
};

const errBody = (code: string, message?: string) => ({ error: code, ...(message ? { message } : {}) });

function errorResponse(e: unknown, headers: Headers): Response {
  if (e instanceof TRPCError) {
    const status = getHTTPStatusCodeFromError(e);
    if (status === 429) headers.set("retry-after", "60");
    // zod-fouten (BAD_REQUEST van de inputvalidatie) leesbaar houden
    let message = e.message;
    if (e.code === "BAD_REQUEST" && e.cause && "issues" in (e.cause as object)) {
      const issues = (e.cause as unknown as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
      message = issues.map((i) => `${i.path.map(String).join(".") || "input"}: ${i.message}`).join("; ");
    }
    return json(status, errBody(e.code, status >= 500 && e.code === "INTERNAL_SERVER_ERROR" && !/^[A-Z_]+/.test(message) ? undefined : message), headers);
  }
  console.error("[rest]", e);
  return json(500, errBody("INTERNAL_SERVER_ERROR"), headers);
}

export async function handleRest(req: Request, deps: RestDeps): Promise<Response> {
  const url = new URL(req.url);
  const sub = url.pathname.startsWith(REST_PREFIX) ? url.pathname.slice(REST_PREFIX.length) : url.pathname;
  const headers = new Headers();

  if (sub === "/openapi.json" && req.method === "GET") {
    return json(200, buildOpenApi(deps.baseUrl ?? url.origin), new Headers({ "access-control-allow-origin": "*" }));
  }
  const m = matchRoute(req.method, sub || "/");
  if (!m) return json(404, errBody("NOT_FOUND", "unknown endpoint; see /api/v1/openapi.json"));
  if ("methodNotAllowed" in m) return json(405, errBody("METHOD_NOT_SUPPORTED"));
  const { route, params } = m;

  try {
    let body: unknown = undefined;
    if (route.body) {
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > MAX_BODY) return json(413, errBody("PAYLOAD_TOO_LARGE"));
      const text = await req.text();
      if (text.length > MAX_BODY) return json(413, errBody("PAYLOAD_TOO_LARGE"));
      if (route.bodyKind === "text") body = text;
      else if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          return json(400, errBody("BAD_REQUEST", "body is not valid JSON"));
        }
      }
    }
    const ctx = await deps.context(req, headers);
    if (!ctx.session) return json(401, errBody("UNAUTHORIZED", "send Authorization: Bearer <api key>"), new Headers({ "www-authenticate": 'Bearer realm="panel"' }));
    const caller = createCallerFactory(deps.router)(ctx) as unknown as Record<string, unknown>;
    const call = (proc: string, input: unknown) => {
      const fn = proc.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], caller) as (i: unknown) => Promise<unknown>;
      return fn(input);
    };
    const parts = { params, query: url.searchParams, body };
    if (route.pre) await route.pre(call, parts);
    const out = await call(route.proc, route.input(parts));
    return json(route.status ?? 200, out ?? null, headers);
  } catch (e) {
    return errorResponse(e, headers);
  }
}
