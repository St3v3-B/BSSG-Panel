/**
 * admin.servers.transfer: een server naar een andere node verplaatsen.
 *
 * Keuze: het panel stuurt de tar-stroom door (relay) in plaats van dat de daemons elkaar aanroepen.
 * Daemons kennen alleen het panel-token van henzelf en vertrouwen elkaar niet; een relay heeft geen
 * node-naar-node-authenticatie, geen extra open verbindingen en geen gedeelde geheimen nodig, en
 * het panel kent al beide tokens. De data stroomt (zonder buffering) bron-daemon -> panel -> doel-daemon.
 *
 * Databases: elke node heeft zijn eigen MariaDB (daemon-beheerd). Per database: aanmaken op het doel met dezelfde
 * naam, gebruiker en wachtwoord, dump van de bron -> panel -> import op het doel. Sites bereiken hun database op elke
 * node als `panel-mariadb:3306`, dus de siteconfig verandert niet. Na de database-update (host_id) wordt de bron-
 * database verwijderd.
 *
 * Volgorde: bron stoppen -> doel aanmaken (skip_install) -> data kopieren -> databases kopieren -> routes op het doel ->
 * database-update (node + allocations + host_id) -> doel starten (als hij draaide) -> bron verwijderen.
 * Alles vóór de database-update wordt bij een fout teruggedraaid door de doelserver te verwijderen;
 * de bron blijft dan ongemoeid (en wordt weer gestart als hij draaide).
 */
import { bedrockPlatform, type Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { logActivity } from "../activity";
import { DaemonHttpError, call, daemonFor } from "../daemon";
import { getDb, schema } from "../db";
import { bedrockAllocation } from "../bedrock";
import { decrypt } from "../lib/crypto";
import { DEFAULT_BEDROCK_PORT, geyserConfig, geyserConfigPath } from "../lib/geyser";
import { buildServerSpec } from "../spec";
import { imagePolicyOf, fetchServerByUuid, limitsOf, serverVariables, sleepOf, autoRestartOf } from "../servers-data";
import { isBackend, syncProxyAddresses } from "../network";
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
  if (!target.supportsDomains) {
    const [dom] = await db.select({ n: count() }).from(schema.domains).where(eq(schema.domains.serverId, b.server.id));
    if (b.server.type === "web" || (dom?.n ?? 0) > 0) throw precondition("NODE_HAS_NO_DOMAINS: the target node does not support websites or domains");
  }
  // Databases op de daemon-beheerde MariaDB van de bronnode gaan mee naar die van het doel. Databases op
  // andere hosts (externe hosts) blijven staan: die zijn vanaf elke node bereikbaar.
  const dbRows = await db
    .select({ d: schema.databases, h: schema.databaseHosts })
    .from(schema.databases)
    .innerJoin(schema.databaseHosts, eq(schema.databaseHosts.id, schema.databases.hostId))
    .where(eq(schema.databases.serverId, b.server.id))
    .orderBy(asc(schema.databases.id));
  const unmovable = dbRows.find((r) => r.h.nodeId === b.node.id && !r.h.daemonManaged);
  if (unmovable) throw precondition(`DATABASE_HOST_NOT_DAEMON_MANAGED: database ${unmovable.d.name} is on host ${unmovable.h.name}, which the node daemon does not manage`);
  const movable = dbRows.filter((r) => r.h.daemonManaged && r.h.nodeId === b.node.id);
  let targetHost: typeof schema.databaseHosts.$inferSelect | undefined;
  if (movable.length) {
    [targetHost] = await db.select().from(schema.databaseHosts).where(and(eq(schema.databaseHosts.nodeId, target.id), eq(schema.databaseHosts.daemonManaged, true)));
    if (!targetHost) throw precondition(`NO_DATABASE_HOST_ON_TARGET: node ${target.name} has no MariaDB (install it with install.sh --node-only, or check that the daemon is up to date)`);
  }

  // Bedrock (Geyser) gaat mee: een eigen UDP-allocation op het doel en een bijgewerkte Geyser-config.
  const platform = b.server.type === "game" ? bedrockPlatform(b.template.slug) : null;
  const oldBedrock = platform ? bedrockAllocation(b) : null;
  const javaCount = b.allocations.filter((a) => a.id !== oldBedrock?.id).length;

  // Allocations op het doel (alleen game): opgegeven of de eerste vrije. Dit zijn de Java-poorten; de Bedrock-poort komt erbij.
  const isWeb = b.server.type === "web";
  let allocIds: number[] = [];
  if (!isWeb) {
    if (input.allocationIds?.length) {
      await checkAllocations(db, input.allocationIds, target.id, null);
      allocIds = input.allocationIds;
    } else {
      const want = Math.max(1, javaCount);
      const free = await db
        .select({ id: schema.allocations.id, port: schema.allocations.port })
        .from(schema.allocations)
        .where(and(eq(schema.allocations.nodeId, target.id), isNull(schema.allocations.serverId)))
        .orderBy(asc(schema.allocations.port));
      if (free.length < want) throw precondition(`NO_FREE_ALLOCATION: node ${target.name} has ${free.length} free allocation(s), ${want} needed`);
      // Met Bedrock aan: de typische Bedrock-poorten niet als Java-poort nemen zolang er andere zijn.
      const bedrockish = (p: number) => !!oldBedrock && (p === oldBedrock.port || p === DEFAULT_BEDROCK_PORT);
      allocIds = [...free.filter((f) => !bedrockish(f.port)), ...free.filter((f) => bedrockish(f.port))].slice(0, want).map((f) => f.id);
    }
  } else if (input.allocationIds?.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "WEB_HAS_NO_ALLOCATIONS" });
  }
  // Bedrock-allocation op het doel: op het IP van de nieuwe primaire poort, bij voorkeur dezelfde poort als nu, anders 19132, anders de laagste vrije.
  let bedrockTarget: { id: number; ip: string; port: number } | null = null;
  if (oldBedrock && allocIds.length) {
    const [primary] = await checkAllocations(db, [allocIds[0]!], target.id, null);
    const free = await db
      .select({ id: schema.allocations.id, ip: schema.allocations.ip, port: schema.allocations.port })
      .from(schema.allocations)
      .where(and(eq(schema.allocations.nodeId, target.id), isNull(schema.allocations.serverId), eq(schema.allocations.ip, primary!.ip)))
      .orderBy(asc(schema.allocations.port));
    const candidates = free.filter((f) => !allocIds.includes(f.id));
    bedrockTarget = candidates.find((f) => f.port === oldBedrock.port) ?? candidates.find((f) => f.port === DEFAULT_BEDROCK_PORT) ?? candidates[0] ?? null;
    if (!bedrockTarget) throw precondition(`NO_FREE_BEDROCK_ALLOCATION: Bedrock is on, but node ${target.name} has no free allocation on ${primary!.ip} for it (add one, or turn Bedrock off first)`);
  }
  const allIds = bedrockTarget ? [...allocIds, bedrockTarget.id] : allocIds;

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
  const createdOnTarget: { name: string; username: string }[] = [];
  try {
    if (wasRunning) {
      await call(() => src.power(uuid, "stop"));
      stopped = true;
      await call(() => waitForState(src, uuid, ["offline"], 120_000));
    }

    const targetAllocs = allIds.length ? await checkAllocations(db, allIds, target.id, null) : [];
    const spec = buildServerSpec({
      uuid,
      template: b.template,
      variables: await serverVariables(b.server.id),
      limits: limitsOf(b.server),
      allocations: targetAllocs.map((a, i) => ({ ip: a.ip, port: a.port, isPrimary: i === 0 })),
      skipInstall: true,
      startOnInstall: false,
      sleep: sleepOf(b.server), autoRestart: autoRestartOf(b.server), imagePolicy: imagePolicyOf(b.server),
    });
    await call(() => dst.createServer(spec));
    targetCreated = true;

    await call(async () => dst.importData(uuid, await src.exportData(uuid)));

    // Geyser luistert op de Bedrock-poort en praat met de Java-poort; beide kunnen op het doel anders zijn.
    if (bedrockTarget && platform) {
      await call(() => dst.writeFile(uuid, geyserConfigPath(platform), geyserConfig({ port: bedrockTarget.port, javaPort: targetAllocs[0]!.port })));
    }

    // Databases kopieren: zelfde naam, gebruiker en wachtwoord. Pas na een gelukte create telt de database als
    // "van ons" op het doel (een bestaande met dezelfde naam geeft 409 en wordt dus nooit weggegooid).
    for (const r of movable) {
      const password = decrypt(r.d.passwordEnc);
      await call(() => dst.dbCreate(r.d.name, r.d.username, password));
      createdOnTarget.push({ name: r.d.name, username: r.d.username });
      await call(async () => dst.dbImport(r.d.name, await src.dbDump(r.d.name)));
    }

    // Routes (web en game-domeinen) op de doelnode zetten voordat de database verandert.
    const domains = await db.select().from(schema.domains).where(eq(schema.domains.serverId, b.server.id));
    for (const d of domains.filter((d) => !isMc(d))) await call(async () => dst.putRoute(await routeFor(d, uuid)));

    await db.transaction(async (tx) => {
      await checkAllocations(tx, allIds, target.id, null);
      // Oude allocations (andere node) vrijgeven, nieuwe toewijzen.
      await tx.update(schema.allocations).set({ serverId: null, isPrimary: false }).where(eq(schema.allocations.serverId, b.server.id));
      if (allIds.length) await assignAllocations(tx, b.server.id, allIds);
      await tx.update(schema.servers).set({ nodeId: target.id, status: "offline", bedrockAllocationId: bedrockTarget?.id ?? null, ...(target.supportsDomains ? {} : { domainsAllowed: false }) }).where(eq(schema.servers.id, b.server.id));
      for (const r of movable) await tx.update(schema.databases).set({ hostId: targetHost!.id }).where(eq(schema.databases.id, r.d.id));
    });
  } catch (e) {
    // Terugdraaien: niets op de bron is veranderd behalve dat hij gestopt is.
    if (targetCreated) await dst.deleteServer(uuid).catch(() => undefined);
    for (const c of createdOnTarget) await dst.dbDrop(c.name, c.username).catch(() => undefined);
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
  // Backend van een Velocity-proxy: het adres in velocity.toml van de proxy bijwerken.
  if (isBackend(b)) {
    try {
      const proxyUuid = await syncProxyAddresses((await fetchServerByUuid(uuid))!);
      if (proxyUuid) warnings.push(`velocity.toml of proxy ${proxyUuid} updated (reloaded if running)`);
    } catch (e) {
      warnings.push(`updating velocity.toml failed: ${(e as Error).message}`);
    }
  }
  // Bron opruimen (verwijdert ook de routes daar). Mislukt dit, dan blijft er een stale kopie: waarschuwing.
  try {
    await src.deleteServer(uuid);
  } catch (e) {
    if (!(e instanceof DaemonHttpError && e.status === 404)) warnings.push(`source cleanup failed: ${(e as Error).message}`);
  }
  // Bron-databases opruimen (het panel wijst nu naar het doel; een mislukte drop laat alleen een stale kopie achter).
  for (const r of movable) {
    try {
      await src.dbDrop(r.d.name, r.d.username);
    } catch (e) {
      warnings.push(`source database ${r.d.name} cleanup failed: ${(e as Error).message}`);
    }
  }
  if (movable.length && movable[0]!.h.host !== targetHost!.host) warnings.push(`database host name changed from ${movable[0]!.h.host} to ${targetHost!.host}: update the site configuration`);
  inProgress.delete(uuid);
  await logActivity({
    action: "admin.server.transfer",
    userId: ctx.session!.userId,
    serverId: b.server.id,
    metadata: { serverUuid: uuid, from: b.node.id, to: target.id, allocationIds: allocIds, ...(bedrockTarget ? { bedrockPort: bedrockTarget.port } : {}), databases: movable.map((r) => r.d.name), restarted: wasRunning, warnings },
    ip: ctx.ip,
    ctx,
  });
  return ok;
};
