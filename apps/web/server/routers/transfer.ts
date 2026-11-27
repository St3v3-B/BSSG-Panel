/**
 * admin.servers.transfer: een server naar een andere node verplaatsen.
 *
 * Keuze: het panel stuurt de tar-stroom door (relay) in plaats van dat de daemons elkaar aanroepen.
 * Daemons kennen alleen het panel-token van henzelf en vertrouwen elkaar niet; een relay heeft geen
 * node-naar-node-authenticatie, geen extra open verbindingen en geen gedeelde geheimen nodig, en
 * het panel kent al beide tokens. De data stroomt (zonder buffering) bron-daemon -> panel -> doel-daemon.
 *
 * Volgorde: bron stoppen -> doel aanmaken (skip_install) -> data kopieren -> routes op het doel ->
 * database-update (node + allocations) -> doel starten (als hij draaide) -> bron verwijderen.
 * Alles vóór de database-update wordt bij een fout teruggedraaid door de doelserver te verwijderen;
 * de bron blijft dan ongemoeid (en wordt weer gestart als hij draaide).
 */
import type { Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { logActivity } from "../activity";
import { DaemonHttpError, call, daemonFor } from "../daemon";
import { getDb, schema } from "../db";
import { buildServerSpec } from "../spec";
import { fetchServerByUuid, imagePolicyOf, limitsOf, serverVariables, sleepOf } from "../servers-data";
import { assignAllocations, checkAllocations, nodeById } from "./admin";
import { isMc, routeFor } from "./domains";

const ok = { ok: true as const };
const inProgress = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const precondition = (m: string) => new TRPCError({ code: "PRECONDITION_FAILED", message: m });
export const transferPollMs = { value: 1000 };

async function waitForState(d: ReturnType<typeof daemonFor>, uuid: string, states: string[], timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    const s = await d.getServer(uuid);
    if (states.includes(s.state)) return s.state;
    if (Date.now() - t0 > timeoutMs) throw precondition(`TRANSFER_STOP_TIMEOUT: server stays ${s.state}`);
    await sleep(transferPollMs.value);
  }
}

export const transfer: Implementation["admin"]["servers"]["transfer"] = async ({ input, ctx }) => {
  const b = await fetchServerByUuid(input.uuid);
  if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "SERVER_NOT_FOUND" });
  const target = await nodeById(input.nodeId).catch(() => {
    throw new TRPCError({ code: "BAD_REQUEST", message: "NODE_NOT_FOUND" });
  });
  if (target.id === b.node.id) throw new TRPCError({ code: "BAD_REQUEST", message: "SAME_NODE" });
  if (inProgress.has(b.server.uuid)) throw new TRPCError({ code: "CONFLICT", message: "TRANSFER_IN_PROGRESS" });
  const db = getDb();
  const [hasDb] = await db.select({ id: schema.databases.id }).from(schema.databases).where(eq(schema.databases.serverId, b.server.id)).limit(1);
  if (hasDb) throw precondition("HAS_DATABASES: databases are bound to the local MariaDB; remove or move them first");

  // Allocations op het doel (alleen game): opgegeven of de eerste vrije.
  const isWeb = b.server.type === "web";
  let allocIds: number[] = [];
  if (!isWeb) {
    if (input.allocationIds?.length) {
      await checkAllocations(db, input.allocationIds, target.id, null);
      allocIds = input.allocationIds;
    } else {
      const want = Math.max(1, b.allocations.length);
      const free = await db
        .select({ id: schema.allocations.id })
        .from(schema.allocations)
        .where(and(eq(schema.allocations.nodeId, target.id), isNull(schema.allocations.serverId)))
        .orderBy(asc(schema.allocations.port))
        .limit(want);
      if (free.length < want) throw precondition(`NO_FREE_ALLOCATION: node ${target.name} has ${free.length} free allocation(s), ${want} needed`);
      allocIds = free.map((f) => f.id);
    }
  } else if (input.allocationIds?.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "WEB_HAS_NO_ALLOCATIONS" });
  }

  const src = daemonFor(b.node);
  const dst = daemonFor(target);
  const uuid = b.server.uuid;
  await call(() => dst.system(5000)); // doel bereikbaar?
  const before = await call(() => src.getServer(uuid));
  if (before.state === "installing" || before.state === "starting" || before.state === "stopping") throw precondition(`SERVER_BUSY: state ${before.state}`);
  const wasRunning = before.state === "online";

  inProgress.add(uuid);
  let targetCreated = false;
  let stopped = false;
  try {
    if (wasRunning) {
      await call(() => src.power(uuid, "stop"));
      stopped = true;
      await call(() => waitForState(src, uuid, ["offline"], 120_000));
    }

    const targetAllocs = allocIds.length ? await checkAllocations(db, allocIds, target.id, null) : [];
    const spec = buildServerSpec({
      uuid,
      template: b.template,
      variables: await serverVariables(b.server.id),
      limits: limitsOf(b.server),
      allocations: targetAllocs.map((a, i) => ({ ip: a.ip, port: a.port, isPrimary: i === 0 })),
      skipInstall: true,
      startOnInstall: false,
      sleep: sleepOf(b.server),
      imagePolicy: imagePolicyOf(b.server),
    });
    await call(() => dst.createServer(spec));
    targetCreated = true;

    await call(async () => dst.importData(uuid, await src.exportData(uuid)));

    // Routes (web en game-domeinen) op de doelnode zetten voordat de database verandert.
    const domains = await db.select().from(schema.domains).where(eq(schema.domains.serverId, b.server.id));
    for (const d of domains.filter((d) => !isMc(d))) await call(async () => dst.putRoute(await routeFor(d, uuid)));

    await db.transaction(async (tx) => {
      await checkAllocations(tx, allocIds, target.id, null);
      // Oude allocations (andere node) vrijgeven, nieuwe toewijzen.
      await tx.update(schema.allocations).set({ serverId: null, isPrimary: false }).where(eq(schema.allocations.serverId, b.server.id));
      if (allocIds.length) await assignAllocations(tx, b.server.id, allocIds);
      await tx.update(schema.servers).set({ nodeId: target.id, status: "offline" }).where(eq(schema.servers.id, b.server.id));
    });
  } catch (e) {
    // Terugdraaien: niets op de bron is veranderd behalve dat hij gestopt is.
    if (targetCreated) await dst.deleteServer(uuid).catch(() => undefined);
    if (stopped) await src.power(uuid, "start").catch(() => undefined);
    inProgress.delete(uuid);
    throw e;
  }

  const warnings: string[] = [];
  try {
    if (wasRunning) {
      await dst.power(uuid, "start");
      await db.update(schema.servers).set({ status: "starting" }).where(eq(schema.servers.id, b.server.id));
    }
  } catch (e) {
    warnings.push(`start on target failed: ${(e as Error).message}`);
  }
  // Bron opruimen (verwijdert ook de routes daar). Mislukt dit, dan blijft er een stale kopie: waarschuwing.
  try {
    await src.deleteServer(uuid);
  } catch (e) {
    if (!(e instanceof DaemonHttpError && e.status === 404)) warnings.push(`source cleanup failed: ${(e as Error).message}`);
  }
  inProgress.delete(uuid);
  await logActivity({
    action: "admin.server.transfer",
    userId: ctx.session!.userId,
    serverId: b.server.id,
    metadata: { serverUuid: uuid, from: b.node.id, to: target.id, allocationIds: allocIds, restarted: wasRunning, warnings },
    ip: ctx.ip,
    ctx,
  });
  return ok;
};
