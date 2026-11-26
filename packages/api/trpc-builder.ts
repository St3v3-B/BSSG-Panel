/**
 * Bouwt de tRPC-router uit het contract plus een implementatie.
 * Dwingt het toegangsniveau (public/pending/user/admin) centraal af en valideert
 * input én output met de zod-schema's uit het contract.
 *
 * Eigenaar: orchestrator.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import type { TRPCBuiltRouter, TRPCMutationProcedure, TRPCQueryProcedure } from "@trpc/server";
import superjson from "superjson";
import type { z } from "zod";
import { contract, type Access, type Contract, type ProcDef } from "./trpc-contract";

/** Sessie zoals de implementatie (panel-api) hem in de context zet. */
export interface SessionCtx {
  sessionId: string;
  userId: number;
  discordId: string;
  isAdmin: boolean; // discord_id staat in admin_discord_ids
  isOwner: boolean;
  isEmergency: boolean;
  blocked: boolean;
  totpEnabled: boolean;
  totpVerified: boolean; // in deze sessie de code ingevoerd
}

export interface Ctx {
  session: SessionCtx | null;
  ip: string | null;
  userAgent: string | null;
  /** Response-headers die procedures mogen zetten (bv. Set-Cookie). */
  resHeaders: Headers;
}

// ---------- types ----------

type IsProc<T> = T extends ProcDef ? true : false;

export type Handler<P extends ProcDef> = (opts: {
  input: z.output<P["input"]>;
  ctx: Ctx;
}) => Promise<z.input<P["output"]>> | z.input<P["output"]>;

/** Wat panel-api (en de mock) moet leveren: voor elke procedure een handler. */
export type Implementation<T = Contract> = {
  [K in keyof T]: IsProc<T[K]> extends true ? Handler<T[K] & ProcDef> : Implementation<T[K]>;
};

const t = initTRPC.context<Ctx>().create({ transformer: superjson });
type Root = typeof t._config.$types;

type ProcOf<P extends ProcDef> = P["kind"] extends "query"
  ? TRPCQueryProcedure<{ input: z.input<P["input"]>; output: z.output<P["output"]>; meta: unknown }>
  : TRPCMutationProcedure<{ input: z.input<P["input"]>; output: z.output<P["output"]>; meta: unknown }>;

type RecordOf<T> = {
  [K in keyof T]: IsProc<T[K]> extends true ? ProcOf<T[K] & ProcDef> : RecordOf<T[K]>;
};

export type AppRouter = TRPCBuiltRouter<Root, RecordOf<Contract>>;

// ---------- toegang ----------

export function checkAccess(access: Access, ctx: Ctx): void {
  if (access === "public") return;
  const s = ctx.session;
  if (!s) throw new TRPCError({ code: "UNAUTHORIZED" });
  if (s.blocked) throw new TRPCError({ code: "FORBIDDEN", message: "BLOCKED" });
  if (access === "pending") return;
  if (s.totpEnabled && !s.totpVerified) throw new TRPCError({ code: "FORBIDDEN", message: "TOTP_PENDING" });
  if (access === "user") return;
  if (!s.isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "NOT_ADMIN" });
  if (!s.totpEnabled || !s.totpVerified) throw new TRPCError({ code: "FORBIDDEN", message: "TOTP_REQUIRED" });
}

// ---------- runtime ----------

function isProc(v: unknown): v is ProcDef {
  return typeof v === "object" && v !== null && "kind" in v && "access" in v && "input" in v;
}

function build(def: Record<string, unknown>, impl: Record<string, unknown>, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(def)) {
    const p = path ? `${path}.${key}` : key;
    const handler = impl?.[key];
    if (isProc(node)) {
      if (typeof handler !== "function") throw new Error(`implementatie ontbreekt voor ${p}`);
      const access = node.access;
      const proc = t.procedure
        .use(({ ctx, next }) => {
          checkAccess(access, ctx);
          return next();
        })
        .input(node.input)
        .output(node.output);
      const fn = handler as (o: { input: unknown; ctx: Ctx }) => unknown;
      out[key] =
        node.kind === "query"
          ? proc.query(({ input, ctx }) => fn({ input, ctx }) as never)
          : proc.mutation(({ input, ctx }) => fn({ input, ctx }) as never);
    } else {
      out[key] = build(node as Record<string, unknown>, (handler ?? {}) as Record<string, unknown>, p);
    }
  }
  return out;
}

export function buildRouter(impl: Implementation): AppRouter {
  return t.router(build(contract as unknown as Record<string, unknown>, impl as unknown as Record<string, unknown>, "") as never) as unknown as AppRouter;
}

/** Implementatie waarin elke procedure NOT_IMPLEMENTED gooit; handig als startpunt. */
export function notImplemented(): Implementation {
  const walk = (def: Record<string, unknown>, path: string): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(def).map(([k, v]) => {
        const p = path ? `${path}.${k}` : k;
        return [
          k,
          isProc(v)
            ? () => {
                throw new TRPCError({ code: "METHOD_NOT_SUPPORTED", message: `NOT_IMPLEMENTED: ${p}` });
              }
            : walk(v as Record<string, unknown>, p),
        ];
      }),
    );
  return walk(contract as unknown as Record<string, unknown>, "") as unknown as Implementation;
}

/** Lijst van alle procedurepaden, bv. voor tests ("admin.servers.create"). */
export function procedurePaths(): Array<{ path: string; def: ProcDef }> {
  const out: Array<{ path: string; def: ProcDef }> = [];
  const walk = (def: Record<string, unknown>, path: string) => {
    for (const [k, v] of Object.entries(def)) {
      const p = path ? `${path}.${k}` : k;
      if (isProc(v)) out.push({ path: p, def: v });
      else walk(v as Record<string, unknown>, p);
    }
  };
  walk(contract as unknown as Record<string, unknown>, "");
  return out;
}

export const createCallerFactory = t.createCallerFactory;
export { superjson };
