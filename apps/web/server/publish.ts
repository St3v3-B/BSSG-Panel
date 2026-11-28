/**
 * Staging → productie voor websites (publish.*).
 *
 * Een staging-site is een geslaagde kopie (server_clones) van een website die nog bestaat. Publiceren zet de
 * bestanden (en optioneel de databases) van staging over productie, als achtergrondtaak met stappen:
 *
 *  1. backup    — backup van productie (bestaande backup-flow, met databases) en wachten tot hij klaar is. Zonder
 *                 S3-doel alleen met `skipBackup` (de gebruiker kiest expliciet "zonder backup doorgaan").
 *  2. prepare   — staging in een werkmap van productie zetten (daemon: `/publish/{id}/copy` op dezelfde node,
 *                 anders de tar-stroom van verplaatsen naar `/publish/{id}/data`). Productie draait intussen door.
 *  3. stop      — productie stoppen (alleen als hij draaide).
 *  4. files     — omwisselen in de daemon (rename, geen kopie) met uitsluitingen: productie houdt zijn eigen
 *                 wp-config.php, .env, panelinstellingen, uploads… Namen `.panel-*` gaan nooit mee.
 *  5. databases — per databasepaar (zelfde basisnaam): eerst een veiligheidskopie van de productiedatabase naar een
 *                 tijdelijke database op dezelfde MariaDB, dan de dump van staging met `import?replace=1` erin,
 *                 met de host van staging → de host van productie (lib/dump-rewrite: veilig voor geserialiseerde
 *                 PHP-data) en voor WordPress een UPDATE van siteurl/home.
 *  6. start     — productie weer starten als hij draaide.
 *  7. finish    — werkmap (oude versie) en tijdelijke databases weg.
 *
 * Mislukt een stap, dan wordt productie teruggezet: databases uit de veiligheidskopie, bestanden met
 * `/publish/{id}/rollback`, en weer gestart als hij draaide. Lukt terugzetten niet, dan blijft de veiligheidskopie
 * staan en staat de naam in de taak (`restored: false`).
 */
import { randomBytes } from "node:crypto";
import type { Ctx, Implementation, Permission, PublishInfo, PublishJob, PublishStepKey } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { logActivity } from "./activity";
import { forbidApiKey } from "./apikey";
import { startBackup, targetForNode } from "./backups";
import { cloneProcedures, reapStaleClones } from "./clone";
import { call, DaemonHttpError, daemonFor, toTrpcError, type DaemonClient } from "./daemon";
import { getDb, schema } from "./db";
import { makeRewriter, rewriteDump, wordpressPrefix, wordpressSiteUrlSql } from "./lib/dump-rewrite";
import { nodeById } from "./routers/admin";
import { accessFor, fetchServerByUuid, isFullAdmin, requireServer, type ServerAccess, type ServerBundle } from "./servers-data";

type Row = typeof schema.sitePublishes.$inferSelect;
type Step = Row["steps"][number];
type DbPair = { from: { d: typeof schema.databases.$inferSelect; h: typeof schema.databaseHosts.$inferSelect }; to: { d: typeof schema.databases.$inferSelect; h: typeof schema.databaseHosts.$inferSelect } };

/** Taken die dit proces uitvoert; een `running`-rij die hier niet in staat, is met een herstart gestorven. */
const active = new Set<number>();
/** Instelbaar in tests. */
export const publishTiming = { pollMs: 1000, stateWaitMs: 120_000, backupWaitMs: 3 * 3600_000 };

const bad = (m: string) => new TRPCError({ code: "BAD_REQUEST", message: m });
const precondition = (m: string) => new TRPCError({ code: "PRECONDITION_FAILED", message: m });
const conflict = (m: string) => new TRPCError({ code: "CONFLICT", message: m });
const errText = (e: unknown) => ((e as Error)?.message ?? String(e)).slice(0, 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Standaarduitsluitingen: configbestanden met omgevingsgegevens, door het panel beheerde bestanden, gebruikersdata. */
export const DEFAULT_EXCLUDES: PublishInfo["defaultExcludes"] = [
  { pattern: "wp-config.php", kind: "wp_config" },
  { pattern: ".env", kind: "env" },
  { pattern: "public/config/config.php", kind: "nextcloud_config" },
  { pattern: "public/config/panel.config.php", kind: "nextcloud_config" },
  { pattern: "/php/00-panel.ini", kind: "panel_settings" },
  { pattern: "/nginx/00-panel.conf", kind: "panel_settings" },
  { pattern: "/php/.disabled-extensions", kind: "panel_settings" },
  { pattern: "/.php/", kind: "php_runtime" },
  { pattern: "public/wp-content/uploads/", kind: "uploads" },
  { pattern: "/nextcloud-data/", kind: "user_data" },
];

// ---------- weergave ----------

function view(r: Row): PublishJob {
  return {
    id: r.id,
    status: r.status,
    staging: { uuid: r.stagingUuid, name: r.stagingName, exists: r.stagingServerId !== null },
    production: { uuid: r.productionUuid, name: r.productionName, exists: r.productionServerId !== null },
    steps: r.steps.map((s) => ({ key: s.key as PublishStepKey, status: s.status })),
    options: r.options,
    backupId: r.backupId,
    databases: r.databases,
    kept: r.kept,
    urlRewrite: r.urlRewrite ?? null,
    warnings: r.warnings,
    restored: r.restored,
    errorCode: r.errorCode,
    error: r.error,
    startedAt: r.createdAt,
    finishedAt: r.finishedAt,
  };
}

// ---------- relaties ----------

/** Productiesite van een staging-site: de bron van de laatste geslaagde kopie naar deze site (website, bestaat nog). */
export async function productionOf(staging: ServerBundle): Promise<ServerBundle | null> {
  if (staging.server.type !== "web") return null;
  const [c] = await getDb()
    .select({ src: schema.serverClones.sourceUuid })
    .from(schema.serverClones)
    .where(and(eq(schema.serverClones.targetServerId, staging.server.id), eq(schema.serverClones.status, "succeeded"), isNotNull(schema.serverClones.sourceServerId)))
    .orderBy(desc(schema.serverClones.id))
    .limit(1);
  if (!c) return null;
  const p = await fetchServerByUuid(c.src);
  return p && p.server.type === "web" && p.server.id !== staging.server.id ? p : null;
}

/** Staging-kopieën van een site (geslaagde kopieën die nog bestaan en websites zijn). */
async function stagingsOf(prod: ServerBundle): Promise<ServerBundle[]> {
  const rows = await getDb()
    .select({ uuid: schema.serverClones.targetUuid, id: schema.serverClones.targetServerId })
    .from(schema.serverClones)
    .where(and(eq(schema.serverClones.sourceServerId, prod.server.id), eq(schema.serverClones.status, "succeeded"), isNotNull(schema.serverClones.targetServerId)))
    .orderBy(desc(schema.serverClones.id));
  const out: ServerBundle[] = [];
  for (const uuid of [...new Set(rows.map((r) => r.uuid))]) {
    const b = await fetchServerByUuid(uuid);
    // Alleen als deze site nog steeds de productie ervan is (een latere kopie van elders telt als nieuwe bron).
    if (b && b.server.type === "web" && (await productionOf(b))?.server.id === prod.server.id) out.push(b);
  }
  return out;
}

async function databasesOf(serverId: number) {
  return getDb()
    .select({ d: schema.databases, h: schema.databaseHosts })
    .from(schema.databases)
    .innerJoin(schema.databaseHosts, eq(schema.databaseHosts.id, schema.databases.hostId))
    .where(eq(schema.databases.serverId, serverId))
    .orderBy(asc(schema.databases.id));
}

/** Basisnaam zonder het voorvoegsel `s<shortId>_` (zoals databases.create en clone ze maken). */
const baseName = (n: string) => n.replace(/^s[0-9a-f]{8}_/, "");

/** Databases van staging en productie gekoppeld op basisnaam. */
async function databasePairs(staging: ServerBundle, prod: ServerBundle): Promise<{ pairs: DbPair[]; unmatched: string[] }> {
  const st = await databasesOf(staging.server.id);
  const pr = await databasesOf(prod.server.id);
  const pairs: DbPair[] = [];
  const unmatched: string[] = [];
  for (const s of st) {
    const p = pr.find((x) => baseName(x.d.name) === baseName(s.d.name) && !pairs.some((q) => q.to.d.id === x.d.id));
    if (p) pairs.push({ from: s, to: p });
    else unmatched.push(s.d.name);
  }
  return { pairs, unmatched };
}

/** Hoofddomein van een site (eerste domein zonder doorverwijzing en zonder wildcard). */
async function primaryHost(serverId: number): Promise<string | null> {
  const rows = await getDb().select().from(schema.domains).where(eq(schema.domains.serverId, serverId)).orderBy(asc(schema.domains.id));
  return rows.find((x) => !x.redirectTo && !x.wildcard)?.hostname ?? null;
}

async function detectApp(b: ServerBundle): Promise<PublishInfo["app"]> {
  const [a] = await getDb()
    .select({ app: schema.appInstalls.appId })
    .from(schema.appInstalls)
    .where(and(eq(schema.appInstalls.serverId, b.server.id), eq(schema.appInstalls.status, "succeeded")))
    .orderBy(desc(schema.appInstalls.id))
    .limit(1);
  return a && (a.app === "wordpress" || a.app === "nextcloud" || a.app === "grav") ? a.app : null;
}

async function backupAvailable(nodeId: number): Promise<boolean> {
  try {
    await targetForNode(nodeId);
    return true;
  } catch {
    return false;
  }
}

/** Running-rijen zonder levend proces (panel herstart): mislukt, en productie zo goed mogelijk terugzetten. */
export async function reapStalePublishes(where?: { serverId: number }): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.sitePublishes)
    .where(and(eq(schema.sitePublishes.status, "running"), where ? or(eq(schema.sitePublishes.stagingServerId, where.serverId), eq(schema.sitePublishes.productionServerId, where.serverId)) : undefined));
  for (const r of rows) {
    if (active.has(r.id)) continue;
    const [claimed] = await db
      .update(schema.sitePublishes)
      .set({ status: "failed", errorCode: "INTERRUPTED", error: "The publish was interrupted (panel restarted). Production was restored where possible; it may still be stopped.", finishedAt: new Date(), steps: r.steps.map((s) => (s.status === "running" ? { ...s, status: "failed" as const } : s.status === "pending" ? { ...s, status: "skipped" as const } : s)) })
      .where(and(eq(schema.sitePublishes.id, r.id), eq(schema.sitePublishes.status, "running")))
      .returning();
    if (!claimed) continue;
    const prod = await fetchServerByUuid(r.productionUuid);
    const warnings = [...r.warnings];
    const ok = prod ? await restoreProduction(r, prod, warnings, false) : false;
    await db.update(schema.sitePublishes).set({ restored: ok, warnings }).where(eq(schema.sitePublishes.id, r.id));
  }
}

/** Loopt er een publicatie met deze site als staging of productie? (Dan geen power/deploy op productie.) */
export async function publishBusy(serverId: number): Promise<boolean> {
  const [r] = await getDb()
    .select({ id: schema.sitePublishes.id })
    .from(schema.sitePublishes)
    .where(and(eq(schema.sitePublishes.status, "running"), or(eq(schema.sitePublishes.productionServerId, serverId), eq(schema.sitePublishes.stagingServerId, serverId))));
  return !!r && active.has(r.id);
}

// ---------- rechten ----------

const has = (a: ServerAccess, p: Permission) => a.canManage || a.permissions.includes(p);
function need(a: ServerAccess, p: Permission) {
  if (!has(a, p)) throw new TRPCError({ code: "FORBIDDEN", message: `MISSING_PERMISSION: ${p}` });
}

/** Ontbrekend recht als code (voor publish.info), of null. */
function missing(st: ServerAccess, pr: ServerAccess, dbs: boolean, backup: boolean): string | null {
  const checks: Array<[ServerAccess, Permission]> = [[st, "files.read"], [pr, "files.write"], [pr, "power"]];
  if (backup) checks.push([pr, "backup.create"]);
  if (dbs) checks.push([st, "database.manage"], [pr, "database.manage"]);
  const m = checks.find(([a, p]) => !has(a, p));
  return m ? `MISSING_PERMISSION: ${m[1]}` : null;
}

async function runningFor(ids: number[]): Promise<Row | null> {
  const [r] = await getDb()
    .select()
    .from(schema.sitePublishes)
    .where(and(eq(schema.sitePublishes.status, "running"), or(inArray(schema.sitePublishes.stagingServerId, ids), inArray(schema.sitePublishes.productionServerId, ids))))
    .orderBy(desc(schema.sitePublishes.id))
    .limit(1);
  return r ?? null;
}

async function liveState(b: ServerBundle): Promise<string | null> {
  try {
    return (await daemonFor(b.node).getServer(b.server.uuid, 3000)).state;
  } catch {
    return null;
  }
}

async function jobFor(ctx: Ctx, id: number): Promise<Row> {
  const db = getDb();
  let [r] = await db.select().from(schema.sitePublishes).where(eq(schema.sitePublishes.id, id));
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "JOB_NOT_FOUND" });
  if (!isFullAdmin(ctx) && r.userId !== ctx.session!.userId) {
    let seen = false;
    for (const uuid of [r.stagingUuid, r.productionUuid]) {
      const b = await fetchServerByUuid(uuid);
      if (!b) continue;
      const a = await accessFor(ctx, b);
      if (a.canManage || a.isSubuser) seen = true;
    }
    if (!seen) throw new TRPCError({ code: "NOT_FOUND", message: "JOB_NOT_FOUND" });
  }
  if (r.status === "running" && !active.has(r.id)) {
    await reapStalePublishes({ serverId: r.productionServerId ?? r.stagingServerId ?? -1 });
    [r] = await db.select().from(schema.sitePublishes).where(eq(schema.sitePublishes.id, id));
  }
  return r!;
}

// ---------- procedures ----------

export const publishProcedures: Implementation["publish"] = {
  info: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "any");
    const b = a.bundle;
    const isWeb = b.server.type === "web";
    await reapStalePublishes({ serverId: b.server.id });
    const prod = isWeb ? await productionOf(b) : null;
    const stagings = isWeb ? await stagingsOf(b) : [];
    const visible: PublishInfo["stagings"] = [];
    for (const s of stagings) {
      const sa = await accessFor(ctx, s);
      if (!sa.canManage && !sa.isSubuser) continue;
      const [last] = await getDb()
        .select({ at: schema.sitePublishes.finishedAt })
        .from(schema.sitePublishes)
        .where(and(eq(schema.sitePublishes.stagingServerId, s.server.id), eq(schema.sitePublishes.productionServerId, b.server.id), eq(schema.sitePublishes.status, "succeeded")))
        .orderBy(desc(schema.sitePublishes.id))
        .limit(1);
      visible.push({ uuid: s.server.uuid, name: s.server.name, lastPublishedAt: last?.at ?? null });
    }
    const running = await runningFor([b.server.id]);
    const base: PublishInfo = {
      role: prod ? "staging" : visible.length ? "production" : "none",
      isWeb,
      production: null,
      stagings: visible,
      canPublish: false,
      reason: isWeb ? "NOT_A_STAGING_SITE" : "NOT_A_WEBSITE",
      backupAvailable: false,
      databases: [],
      unmatchedDatabases: [],
      defaultExcludes: DEFAULT_EXCLUDES,
      app: isWeb ? await detectApp(b) : null,
      stagingHost: null,
      productionHost: null,
      notes: [],
      running: running ? view(running) : null,
    };
    if (!prod) return base;
    const pa = await accessFor(ctx, prod);
    if (!pa.canManage && !pa.isSubuser) return { ...base, role: "staging", reason: "PRODUCTION_NO_ACCESS" };
    const { pairs, unmatched } = await databasePairs(b, prod);
    const backup = await backupAvailable(prod.node.id);
    const [deploy] = await getDb().select({ id: schema.deployConfigs.serverId }).from(schema.deployConfigs).where(eq(schema.deployConfigs.serverId, prod.server.id));
    const stagingHost = await primaryHost(b.server.id);
    const productionHost = await primaryHost(prod.server.id);
    const notes: PublishInfo["notes"] = [];
    if (deploy) notes.push("production_git_deploy");
    if (prod.node.id !== b.node.id) notes.push("cross_node");
    if (!stagingHost || !productionHost) notes.push("no_domains");
    if (pairs.some((p) => !p.from.h.daemonManaged || !p.to.h.daemonManaged || p.from.h.nodeId === null || p.to.h.nodeId === null)) notes.push("databases_external");
    const forbidden = apiKeyReason(ctx) ?? missing(a, pa, false, backup);
    const prodRunning = running ?? (await runningFor([prod.server.id]));
    return {
      ...base,
      role: "staging",
      production: { uuid: prod.server.uuid, name: prod.server.name, sameNode: prod.node.id === b.node.id },
      canPublish: !forbidden && !prodRunning,
      reason: forbidden ?? (prodRunning ? "PUBLISH_IN_PROGRESS" : null),
      backupAvailable: backup,
      databases: pairs.map((p) => ({ from: p.from.d.name, to: p.to.d.name })),
      unmatchedDatabases: unmatched,
      app: base.app ?? (await detectApp(prod)),
      stagingHost,
      productionHost,
      notes,
      running: prodRunning ? view(prodRunning) : null,
    };
  },

  createStaging: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    if (a.bundle.server.type !== "web") throw bad("NOT_A_WEBSITE");
    const name = (input.name ?? `${a.bundle.server.name} (staging)`).slice(0, 100);
    return cloneProcedures.clone({ input: { uuid: input.uuid, name, copyDatabases: input.copyDatabases, domain: input.domain, startAfter: false }, ctx } as never);
  },

  start: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const st = await requireServer(ctx, input.uuid, "files.read", { mutates: true });
    const staging = st.bundle;
    if (staging.server.type !== "web") throw bad("NOT_A_WEBSITE");
    const prod = await productionOf(staging);
    if (!prod) throw bad("NOT_A_STAGING_SITE");
    if (!input.files && !input.databases) throw bad("NOTHING_TO_PUBLISH");
    if (input.databases && !input.confirmDatabases) throw bad("CONFIRM_DATABASES");
    const pr = await requireServer(ctx, prod.server.uuid, "files.write", { mutates: true });
    need(pr, "power");
    if (input.databases) {
      need(st, "database.manage");
      need(pr, "database.manage");
    }
    const backup = await backupAvailable(prod.node.id);
    if (backup) need(pr, "backup.create");
    else if (!input.skipBackup) throw precondition("BACKUP_UNAVAILABLE: there is no backup target for this node; confirm publishing without a backup");

    const ids = [staging.server.id, prod.server.id];
    await reapStalePublishes({ serverId: prod.server.id });
    await reapStalePublishes({ serverId: staging.server.id });
    if (await runningFor(ids)) throw conflict("PUBLISH_IN_PROGRESS");
    for (const id of ids) await reapStaleClones({ serverId: id });
    const [cl] = await getDb()
      .select({ id: schema.serverClones.id })
      .from(schema.serverClones)
      .where(and(eq(schema.serverClones.status, "running"), or(inArray(schema.serverClones.sourceServerId, ids), inArray(schema.serverClones.targetServerId, ids))));
    if (cl) throw conflict("CLONE_IN_PROGRESS");
    const [dep] = await getDb().select({ id: schema.deploys.id }).from(schema.deploys).where(and(eq(schema.deploys.serverId, prod.server.id), eq(schema.deploys.status, "running")));
    if (dep) throw conflict("DEPLOY_RUNNING");

    const pState = await liveState(prod);
    if (pState === null) await call(() => daemonFor(prod.node).getServer(prod.server.uuid, 3000)); // gooit DAEMON_UNREACHABLE
    const sState = await liveState(staging);
    if (sState === null) await call(() => daemonFor(staging.node).getServer(staging.server.uuid, 3000));
    if (pState === "installing" || sState === "installing") throw precondition("SERVER_BUSY: a site is installing");

    let pairs: DbPair[] = [];
    const warnings: string[] = [];
    if (input.databases) {
      const dp = await databasePairs(staging, prod);
      pairs = dp.pairs;
      if (!pairs.length) throw precondition("NO_MATCHING_DATABASES: production has no database with the same name as one of staging");
      const external = pairs.find((p) => !p.from.h.daemonManaged || !p.to.h.daemonManaged || p.from.h.nodeId === null || p.to.h.nodeId === null);
      if (external) throw precondition(`DATABASE_NOT_MANAGED: ${external.to.d.name} is on a database host the panel cannot dump/restore`);
      if (dp.unmatched.length) warnings.push(`Staging databases without a production counterpart were not published: ${dp.unmatched.join(", ")}`);
    }
    if (!backup) warnings.push("No backup was made (no backup target): you chose to continue without one.");
    const exclude = input.exclude ?? DEFAULT_EXCLUDES.map((e) => e.pattern);
    const sameNode = staging.node.id === prod.node.id;
    const step = (key: PublishStepKey, on: boolean): Step => ({ key, status: on ? "pending" : "skipped" });
    const [job] = await getDb()
      .insert(schema.sitePublishes)
      .values({
        stagingServerId: staging.server.id,
        productionServerId: prod.server.id,
        stagingUuid: staging.server.uuid,
        productionUuid: prod.server.uuid,
        stagingName: staging.server.name,
        productionName: prod.server.name,
        userId: ctx.session!.userId,
        steps: [step("backup", backup), step("prepare", input.files), step("stop", true), step("files", input.files), step("databases", input.databases), step("start", true), step("finish", true)],
        options: { files: input.files, databases: input.databases, exclude, rewriteUrls: input.rewriteUrls, backup, sameNode },
        databases: pairs.map((p) => ({ from: p.from.d.name, to: p.to.d.name })),
        warnings,
      })
      .returning();
    const meta = { publishId: job!.id, stagingUuid: staging.server.uuid, productionUuid: prod.server.uuid, files: input.files, databases: job!.databases, exclude, backup };
    await logActivity({ action: "server.publish.start", userId: ctx.session!.userId, serverId: prod.server.id, metadata: meta, ip: ctx.ip, ctx });
    await logActivity({ action: "server.publish.start", userId: ctx.session!.userId, serverId: staging.server.id, metadata: meta, ip: ctx.ip, ctx });
    active.add(job!.id);
    void runPublish({ job: job!, staging, prod, pairs, wasState: pState }).finally(() => active.delete(job!.id));
    return view(job!);
  },

  job: async ({ input, ctx }) => view(await jobFor(ctx, input.id)),

  history: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "any");
    await reapStalePublishes({ serverId: a.bundle.server.id });
    const rows = await getDb()
      .select()
      .from(schema.sitePublishes)
      .where(or(eq(schema.sitePublishes.stagingServerId, a.bundle.server.id), eq(schema.sitePublishes.productionServerId, a.bundle.server.id)))
      .orderBy(desc(schema.sitePublishes.id))
      .limit(20);
    return rows.map(view);
  },
};

function apiKeyReason(ctx: Ctx): string | null {
  try {
    forbidApiKey(ctx);
    return null;
  } catch {
    return "NOT_WITH_API_KEY";
  }
}

// ---------- uitvoeren ----------

interface RunInput {
  job: Row;
  staging: ServerBundle;
  prod: ServerBundle;
  pairs: DbPair[];
  wasState: string | null;
}

const isUp = (s: string | null) => s === "online" || s === "starting" || s === "stopping";
const unknownPath = (e: unknown) => e instanceof DaemonHttpError && e.status === 404 && /unknown path/i.test(e.message);
const tooOld = () => precondition("DAEMON_TOO_OLD: the node's daemon does not support publishing yet; update it first");

async function waitState(d: DaemonClient, uuid: string, ok: (s: string) => boolean, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const s = await call(() => d.getServer(uuid));
    if (ok(s.state)) return;
    if (Date.now() - t0 > publishTiming.stateWaitMs) throw precondition(`PUBLISH_${what}: production stays ${s.state}`);
    await sleep(publishTiming.pollMs);
  }
}
const stoppedState = (s: string) => s === "offline" || s === "install_failed" || s === "sleeping";

async function waitBackup(id: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const [b] = await getDb().select().from(schema.backups).where(eq(schema.backups.id, id));
    if (!b) throw precondition("BACKUP_FAILED: the backup disappeared");
    if (b.status === "completed") return;
    if (b.status === "failed") throw precondition(`BACKUP_FAILED: ${b.error ?? "unknown error"}`);
    if (Date.now() - t0 > publishTiming.backupWaitMs) throw precondition("BACKUP_FAILED: the backup did not finish in time");
    await sleep(publishTiming.pollMs);
  }
}

/** Daemon die bij een databasehost hoort. */
async function hostDaemon(h: typeof schema.databaseHosts.$inferSelect): Promise<DaemonClient> {
  if (!h.nodeId) throw precondition("DATABASE_NOT_MANAGED");
  return daemonFor(await nodeById(h.nodeId));
}

const tempPassword = () => randomBytes(24).toString("base64url");

async function runPublish(r: RunInput): Promise<void> {
  const db = getDb();
  const { job, staging, prod } = r;
  const steps = job.steps.map((s) => ({ ...s }));
  const warnings = [...job.warnings];
  const temps = [...job.tempDatabases];
  let kept: string[] = [];
  let urlRewrite: Row["urlRewrite"] = null;
  const prodD = daemonFor(prod.node);
  const stagD = daemonFor(staging.node);
  const save = (extra: Partial<typeof schema.sitePublishes.$inferInsert> = {}) =>
    db.update(schema.sitePublishes).set({ steps: steps.map((s) => ({ ...s })), warnings: [...warnings], tempDatabases: temps.map((t) => ({ ...t })), kept, urlRewrite, ...extra }).where(eq(schema.sitePublishes.id, job.id));
  const set = async (key: PublishStepKey, status: Step["status"]) => {
    const s = steps.find((x) => x.key === key);
    if (s) s.status = status;
    await save();
  };
  const isOn = (key: PublishStepKey) => steps.find((s) => s.key === key)?.status !== "skipped";
  let touched = false; // productie is veranderd (gestopt, omgewisseld of database vervangen)
  let stoppedByUs = false;
  try {
    // 1. Backup.
    if (isOn("backup")) {
      await set("backup", "running");
      const b = await startBackup(prod, { name: `Before publishing ${staging.server.name}`.slice(0, 100), includeDatabases: true, userId: job.userId });
      await save({ backupId: b.id });
      await waitBackup(b.id);
      await set("backup", "done");
    }

    // 2. Werkmap vullen (productie draait door).
    if (isOn("prepare")) {
      await set("prepare", "running");
      try {
        if (job.options.sameNode) await prodD.publishCopy(prod.server.uuid, job.id, staging.server.uuid);
        else await prodD.publishData(prod.server.uuid, job.id, await stagD.exportData(staging.server.uuid, { live: true, excludeInternal: true }));
      } catch (e) {
        if (unknownPath(e)) throw tooOld();
        throw toTrpcError(e);
      }
      await set("prepare", "done");
    }

    // 3. Productie stoppen.
    await set("stop", "running");
    const now = await liveState(prod);
    if (isUp(now)) {
      touched = true;
      stoppedByUs = true;
      await call(() => prodD.power(prod.server.uuid, "stop"));
      await waitState(prodD, prod.server.uuid, stoppedState, "STOP_TIMEOUT");
    }
    await set("stop", "done");

    // 4. Omwisselen.
    if (isOn("files")) {
      await set("files", "running");
      touched = true;
      const log = await call(() => prodD.publishSwap(prod.server.uuid, job.id, job.options.exclude));
      kept = log.filter((l) => l.startsWith("kept ")).map((l) => l.slice(5));
      await set("files", "done");
    }

    // 5. Databases: veiligheidskopie, dan vervangen (met URL-vervanging).
    if (isOn("databases")) {
      await set("databases", "running");
      const from = await primaryHost(staging.server.id);
      const to = await primaryHost(prod.server.id);
      const rewrite = job.options.rewriteUrls && from && to && from !== to ? makeRewriter(from, to) : null;
      if (job.options.rewriteUrls && !rewrite) warnings.push("URLs were not replaced: staging or production has no domain.");
      let prefix: string | null = null;
      if (rewrite) {
        try {
          prefix = wordpressPrefix(await prodD.readFile(prod.server.uuid, "/wp-config.php"));
        } catch {
          prefix = null; // geen WordPress (of geen wp-config.php in de root)
        }
      }
      let i = 0;
      for (const p of r.pairs) {
        i++;
        const hd = await hostDaemon(p.to.h);
        const sd = await hostDaemon(p.from.h);
        const t = { name: `pb${job.id}_${i}`, username: `pb${job.id}u${i}`, of: p.to.d.name, nodeId: p.to.h.nodeId!, imported: false };
        await call(() => hd.dbCreate(t.name, t.username, tempPassword()));
        temps.push(t);
        await save();
        await call(async () => hd.dbImport(t.name, await hd.dbDump(p.to.d.name)));
        t.imported = true; // vanaf hier kan productie veranderd zijn: bij een fout terugzetten
        await save();
        const append = rewrite && prefix ? wordpressSiteUrlSql(prefix, rewrite.from, rewrite.to) : undefined;
        await call(async () => {
          const dump = await sd.dbDump(p.from.d.name);
          await hd.dbImport(p.to.d.name, rewrite ? rewriteDump(dump, rewrite, append) : dump, { replace: true });
        });
        if (rewrite) urlRewrite = { from: rewrite.from, to: rewrite.to, replaced: rewrite.stats.replaced, skipped: rewrite.stats.skipped };
        await save();
      }
      if (urlRewrite && urlRewrite.skipped > 0) warnings.push(`${urlRewrite.skipped} value(s) looked like serialized data that could not be parsed and were left unchanged; check them if the site still links to staging.`);
      await set("databases", "done");
    }

    // 6. Weer in de oude staat.
    await set("start", "running");
    if (stoppedByUs) {
      await call(() => prodD.power(prod.server.uuid, "start"));
      await db.update(schema.servers).set({ status: "starting" }).where(eq(schema.servers.id, prod.server.id));
    }
    await set("start", "done");

    // 7. Opruimen.
    await set("finish", "running");
    if (isOn("files")) {
      try {
        await prodD.publishFinish(prod.server.uuid, job.id);
      } catch (e) {
        warnings.push(`Removing the previous version failed (it stays in .panel-publish-${job.id}): ${errText(e)}`);
      }
    }
    await dropTemps(temps, warnings);
    const [dep] = await db.select({ id: schema.deployConfigs.serverId }).from(schema.deployConfigs).where(eq(schema.deployConfigs.serverId, prod.server.id));
    if (dep && isOn("files")) warnings.push("Production deploys from Git: the next deploy replaces the published files in its target folder.");
    steps.find((s) => s.key === "finish")!.status = "done";
    await save({ status: "succeeded", finishedAt: new Date() });
    const meta = { publishId: job.id, stagingUuid: staging.server.uuid, productionUuid: prod.server.uuid, kept, databases: job.databases, urlRewrite, warnings };
    await logActivity({ action: "server.publish.complete", userId: job.userId, serverId: prod.server.id, metadata: meta });
    await logActivity({ action: "server.publish.complete", userId: job.userId, serverId: staging.server.id, metadata: meta });
  } catch (e) {
    for (const s of steps) if (s.status === "running") s.status = "failed";
    for (const s of steps) if (s.status === "pending") s.status = "skipped";
    const code = e instanceof TRPCError ? e.message.split(":")[0]!.trim() : "PUBLISH_FAILED";
    let restored: boolean | null = null;
    if (touched || isOn("prepare")) {
      const [cur] = await db.select().from(schema.sitePublishes).where(eq(schema.sitePublishes.id, job.id));
      const ok = await restoreProduction({ ...(cur ?? job), tempDatabases: temps }, prod, warnings, stoppedByUs);
      restored = touched ? ok : null;
    }
    await save({ status: "failed", errorCode: code, error: errText(e), restored, finishedAt: new Date() }).catch(() => undefined);
    const meta = { publishId: job.id, stagingUuid: staging.server.uuid, productionUuid: prod.server.uuid, error: errText(e), restored };
    await logActivity({ action: "server.publish.failed", userId: job.userId, serverId: prod.server.id, metadata: meta });
    await logActivity({ action: "server.publish.failed", userId: job.userId, serverId: staging.server.id, metadata: meta });
  }
}

/**
 * Productie terug zoals hij was: databases uit de veiligheidskopie, bestanden via de daemon (rollback is idempotent;
 * zonder swap ruimt hij alleen de werkmap op), en weer starten als wij hem stopten. Geeft true als alles lukte.
 */
async function restoreProduction(row: Row, prod: ServerBundle, warnings: string[], start: boolean): Promise<boolean> {
  let ok = true;
  const d = daemonFor(prod.node);
  const keep = new Set<string>();
  for (const t of row.tempDatabases.filter((x) => x.imported)) {
    try {
      const hd = daemonFor(await nodeById(t.nodeId));
      await hd.dbImport(t.of, await hd.dbDump(t.name), { replace: true });
    } catch (e) {
      ok = false;
      keep.add(t.name); // niet weggooien: dit is de enige kopie
      warnings.push(`Restoring database ${t.of} failed; its previous content is kept in database ${t.name}: ${errText(e)}`);
    }
  }
  try {
    await d.publishRollback(prod.server.uuid, row.id);
  } catch (e) {
    if (!unknownPath(e)) {
      ok = false;
      warnings.push(`Restoring the files failed: ${errText(e)}`);
    }
  }
  if (start && ok) {
    try {
      await d.power(prod.server.uuid, "start");
    } catch (e) {
      warnings.push(`Starting production again failed: ${errText(e)}`);
    }
  }
  await dropTemps(row.tempDatabases.filter((x) => !keep.has(x.name)), warnings);
  return ok;
}

async function dropTemps(temps: Row["tempDatabases"], warnings: string[]): Promise<void> {
  for (const t of temps) {
    try {
      const hd = daemonFor(await nodeById(t.nodeId));
      await hd.dbDrop(t.name, t.username);
    } catch (e) {
      warnings.push(`Removing the temporary database ${t.name} failed: ${errText(e)}`);
    }
  }
}
