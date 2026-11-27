/** apps.*: one-click apps for websites (catalogue in ../apps/catalog.ts, engine in ../apps/engine.ts). */
import type { AppJob, AppSummary, Ctx, Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { logActivity } from "../activity";
import { AppError, checkPublic, install, stepKeys, type SiteTarget } from "../apps/engine";
import { appById, CATALOG, type AppDef } from "../apps/catalog";
import { call, daemonFor, DaemonHttpError } from "../daemon";
import { getDb, schema } from "../db";
import { getEnv } from "../env";
import { decrypt, encrypt } from "../lib/crypto";
import { signBrowserJwt } from "../lib/jwt";
import { requireServer, type ServerAccess } from "../servers-data";
import { createServerDatabase, removeServerDatabase } from "./databases";

type Row = typeof schema.appInstalls.$inferSelect;
type Result = NonNullable<AppJob["result"]>;

/** Jobs this process is working on; a "running" row that is not in here died with a restart. */
const active = new Set<number>();
const STALE_MS = 45 * 60_000;

/** Site file system through the daemon. */
export function daemonTarget(ctx: Ctx, a: ServerAccess, uuid: string): SiteTarget {
  const client = daemonFor(a.bundle.node);
  const missing = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DaemonHttpError && e.status === 404) return null;
      throw e;
    }
  };
  return {
    listDir: async (p) => (await missing(() => client.listFiles(uuid, p)))?.map((f) => ({ name: f.name, isDirectory: f.is_directory })) ?? null,
    readText: (p) => missing(() => client.readFile(uuid, p)),
    mkdir: (p) => client.mkdir(uuid, p),
    write: (p, c) => client.writeFile(uuid, p, c),
    rename: (f, t) => client.rename(uuid, f, t),
    remove: (ps) => client.deleteFiles(uuid, ps),
    decompress: (p) => client.decompress(uuid, p),
    upload: async (dir, name, file) => {
      const { token } = await signBrowserJwt({ iss: getEnv().PANEL_URL, aud: a.bundle.node.fqdn, sub: String(ctx.session!.userId), serverUuid: uuid, permissions: ["files.write"], extra: { directory: dir } });
      await client.uploadFile(uuid, dir, token, name, file);
    },
  };
}

/** Replaceable in tests (a local directory instead of the daemon). */
export const hooks: { target: typeof daemonTarget } = { target: daemonTarget };

const parseResult = (r: Row): Result | null => (r.resultEnc ? (JSON.parse(decrypt(r.resultEnc)) as Result) : null);

const toJob = (r: Row, uuid: string, result: Result | null): AppJob => ({
  id: r.id,
  serverUuid: uuid,
  appId: r.appId,
  appName: appById(r.appId)?.name ?? r.appId,
  status: r.status,
  steps: r.steps,
  errorCode: r.errorCode,
  error: r.error,
  result,
  startedAt: r.createdAt,
  finishedAt: r.finishedAt,
});

function templateOk(def: AppDef, b: ServerAccess["bundle"]): string | null {
  if (b.template.type !== "web") return "Apps can only be installed on websites.";
  if (!b.template.slug.startsWith(def.templatePrefix)) return `${def.name} needs a PHP website (this site uses ${b.template.name}).`;
  return null;
}

async function reapStale(serverId: number) {
  const rows = await getDb().select().from(schema.appInstalls).where(and(eq(schema.appInstalls.serverId, serverId), eq(schema.appInstalls.status, "running")));
  for (const r of rows) {
    const dead = !active.has(r.id) || Date.now() - r.createdAt.getTime() > STALE_MS;
    if (!dead) continue;
    const steps = r.steps.map((s) => (s.status === "running" ? { ...s, status: "failed" as const } : s));
    await getDb().update(schema.appInstalls).set({ status: "failed", steps, errorCode: "INTERRUPTED", error: "The installation was interrupted (panel restarted or timed out).", finishedAt: new Date() }).where(eq(schema.appInstalls.id, r.id));
  }
}

async function jobRow(ctx: Ctx, id: number) {
  const [r] = await getDb().select({ j: schema.appInstalls, uuid: schema.servers.uuid }).from(schema.appInstalls).innerJoin(schema.servers, eq(schema.servers.id, schema.appInstalls.serverId)).where(eq(schema.appInstalls.id, id));
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "JOB_NOT_FOUND" });
  const a = await requireServer(ctx, r.uuid, "files.write");
  await reapStale(a.bundle.server.id);
  const [j] = await getDb().select().from(schema.appInstalls).where(eq(schema.appInstalls.id, id));
  return { j: j!, uuid: r.uuid };
}

async function runJob(ctx: Ctx, a: ServerAccess, uuid: string, def: AppDef, job: Row, o: { replaceExisting: boolean; admin: { username: string; email: string } | null }) {
  active.add(job.id);
  const steps = job.steps.map((s) => ({ ...s }));
  const setStep = async (key: string, status: "running" | "done" | "failed") => {
    const s = steps.find((x) => x.key === key);
    if (s) s.status = status === "running" ? "running" : status;
    await getDb().update(schema.appInstalls).set({ steps: steps.map((x) => ({ ...x })) }).where(eq(schema.appInstalls.id, job.id));
  };
  try {
    const out = await install({
      def,
      target: hooks.target(ctx, a, uuid),
      replaceExisting: o.replaceExisting,
      siteName: a.bundle.server.name,
      domains: a.bundle.domains,
      admin: o.admin,
      tmpName: `.panel-app-${job.id}`,
      step: setStep,
      provisionDb: async () => {
        let last: unknown;
        for (let i = 1; i <= 5; i++) {
          try {
            const d = await createServerDatabase(ctx, a, uuid, i === 1 ? def.id : `${def.id}_${i}`, null);
            return { db: { host: d.host, port: d.port, name: d.name, user: d.username, password: d.password }, rollback: () => removeServerDatabase(d.id) };
          } catch (e) {
            last = e;
            if (!(e instanceof TRPCError && e.message === "DATABASE_EXISTS")) break;
          }
        }
        throw new AppError("DATABASE_FAILED", last instanceof Error ? last.message : String(last));
      },
    });
    await getDb().update(schema.appInstalls).set({ status: "succeeded", resultEnc: encrypt(JSON.stringify(out)), finishedAt: new Date() }).where(eq(schema.appInstalls.id, job.id));
    await logActivity({ action: "server.app.install", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { app: def.id, version: out.version }, ip: ctx.ip, ctx });
  } catch (e) {
    const code = e instanceof AppError ? e.code : e instanceof TRPCError ? e.message.split(":")[0]! : "INSTALL_FAILED";
    const msg = e instanceof Error ? e.message : String(e);
    await getDb().update(schema.appInstalls).set({ status: "failed", errorCode: code, error: msg.slice(0, 500), finishedAt: new Date() }).where(eq(schema.appInstalls.id, job.id));
    await logActivity({ action: "server.app.install_failed", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { app: def.id, code }, ip: ctx.ip, ctx });
  } finally {
    active.delete(job.id);
  }
}

export const apps: Implementation["apps"] = {
  catalog: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write");
    return CATALOG.map((d): AppSummary => {
      const why = templateOk(d, a.bundle);
      return { id: d.id, name: d.name, description: d.description, homepage: d.homepage, requiresDatabase: d.database, supportsAdmin: d.admin, downloadMb: d.downloadMb, compatible: !why, incompatibleReason: why };
    });
  },

  check: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write");
    if (!appById(input.appId)) throw new TRPCError({ code: "NOT_FOUND", message: "APP_NOT_FOUND" });
    return call(() => checkPublic(hooks.target(ctx, a, input.uuid)));
  },

  install: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write", { mutates: true });
    const def = appById(input.appId);
    if (!def) throw new TRPCError({ code: "NOT_FOUND", message: "APP_NOT_FOUND" });
    if (def.database && !a.permissions.includes("database.manage")) throw new TRPCError({ code: "FORBIDDEN", message: "MISSING_PERMISSION: database.manage" });
    const why = templateOk(def, a.bundle);
    if (why) throw new TRPCError({ code: "BAD_REQUEST", message: `APP_INCOMPATIBLE: ${why}` });
    const serverId = a.bundle.server.id;
    await reapStale(serverId);
    const [running] = await getDb().select({ id: schema.appInstalls.id }).from(schema.appInstalls).where(and(eq(schema.appInstalls.serverId, serverId), eq(schema.appInstalls.status, "running")));
    if (running) throw new TRPCError({ code: "CONFLICT", message: "INSTALL_RUNNING" });
    const pub = await call(() => checkPublic(hooks.target(ctx, a, input.uuid)));
    if (!pub.publicEmpty && !input.replaceExisting) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "PUBLIC_NOT_EMPTY" });
    const admin = def.admin ? input.admin : null;
    const [row] = await getDb()
      .insert(schema.appInstalls)
      .values({ serverId, userId: ctx.session!.userId, appId: def.id, steps: stepKeys(def).map((key) => ({ key, status: "pending" as const })) })
      .returning();
    void runJob(ctx, a, input.uuid, def, row!, { replaceExisting: input.replaceExisting, admin }).catch((e) => console.error("[apps] job", row!.id, "bookkeeping failed:", e));
    return toJob(row!, input.uuid, null);
  },

  job: async ({ input, ctx }) => {
    const { j, uuid } = await jobRow(ctx, input.id);
    let result = parseResult(j);
    if (j.status === "succeeded" && result?.adminPassword) {
      // The admin password is shown once: whoever fetches it first gets it, then it is wiped.
      const wiped = encrypt(JSON.stringify({ ...result, adminPassword: null }));
      const won = await getDb().update(schema.appInstalls).set({ resultEnc: wiped }).where(and(eq(schema.appInstalls.id, j.id), eq(schema.appInstalls.resultEnc, j.resultEnc!))).returning({ id: schema.appInstalls.id });
      if (!won.length) result = { ...result, adminPassword: null };
    }
    return toJob(j, uuid, result);
  },

  jobs: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write");
    await reapStale(a.bundle.server.id);
    const rows = await getDb().select().from(schema.appInstalls).where(eq(schema.appInstalls.serverId, a.bundle.server.id)).orderBy(desc(schema.appInstalls.id)).limit(5);
    return rows.map((r) => toJob(r, input.uuid, r.status === "succeeded" ? { ...parseResult(r)!, adminPassword: null } : null));
  },
};
