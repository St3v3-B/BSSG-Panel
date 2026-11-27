/**
 * Minecraft-netwerk (servers.networkCandidates / servers.updateNetwork).
 *
 * velocity.toml gaat via de daemon-bestands-API (lezen, `[servers]`/`try`/forwarding-mode aanpassen,
 * terugschrijven) en niet via config_files: `set` kan geen serverlijst vervangen of verwijderde
 * servers opruimen, en zo blijft de rest van het bestand (en de commentaren van de eigenaar) intact.
 */
import type { Implementation, NetworkUpdateResult } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { logActivity } from "../activity";
import { DaemonHttpError, call, daemonFor } from "../daemon";
import { getDb, schema } from "../db";
import { applyNetworkToml } from "../lib/velocity-toml";
import { FORWARDING_VAR, PROXY_SECRET_VAR, SECRET_VAR, allocationAddress, forcedHostsOf, isBackend, isProxy, memberAddresses, proxyMembers, suggestNames, tomlForcedHosts } from "../network";
import { syncBedrockBackends } from "../bedrock";
import { buildServerSpec } from "../spec";
import { imagePolicyOf, fetchServerByUuid, fetchServers, isFullAdmin, limitsOf, requireServer, serverVariables, sleepOf, autoRestartOf, type ServerBundle } from "../servers-data";

const TOML_PATH = "/velocity.toml";
const bad = (message: string, code: "BAD_REQUEST" | "FORBIDDEN" | "CONFLICT" | "NOT_FOUND" | "PRECONDITION_FAILED" = "BAD_REQUEST") => new TRPCError({ code, message });

/** Variabelen van een server bijwerken: daemon-spec (zonder install), dan database. Effect bij de volgende start. */
export async function setVariables(b: ServerBundle, vars: Record<string, string>) {
  const merged = { ...(await serverVariables(b.server.id)), ...vars };
  const spec = buildServerSpec({ uuid: b.server.uuid, template: b.template, variables: merged, limits: limitsOf(b.server), allocations: b.allocations, skipInstall: true, sleep: sleepOf(b.server), autoRestart: autoRestartOf(b.server), imagePolicy: imagePolicyOf(b.server) });
  await call(() => daemonFor(b.node).updateServer(b.server.uuid, spec));
  await getDb()
    .insert(schema.serverVariables)
    .values(Object.entries(vars).map(([key, value]) => ({ serverId: b.server.id, key, value })))
    .onConflictDoUpdate({ target: [schema.serverVariables.serverId, schema.serverVariables.key], set: { value: sql`excluded.value` } });
}

async function isRunning(b: ServerBundle): Promise<boolean> {
  try {
    const st = await daemonFor(b.node).getServer(b.server.uuid, 2000);
    return st.state === "online" || st.state === "starting";
  } catch {
    return false;
  }
}

async function proxyAccess(ctx: Parameters<typeof requireServer>[0], uuid: string) {
  const a = await requireServer(ctx, uuid, "owner");
  if (!isProxy(a.bundle)) throw bad("NOT_A_PROXY");
  return a;
}

export const network: Pick<Implementation["servers"], "networkCandidates" | "updateNetwork"> = {
  networkCandidates: async ({ input, ctx }) => {
    const { bundle: p } = await proxyAccess(ctx, input.uuid);
    const uid = ctx.session!.userId;
    const rows = await fetchServers(and(eq(schema.servers.nodeId, p.node.id), eq(schema.servers.type, "game"), ne(schema.servers.id, p.server.id)));
    const list = rows.filter((b) => isBackend(b) && (b.server.ownerId === uid || isFullAdmin(ctx)));
    const taken = list.length
      ? await getDb()
          .select({ backend: schema.networkMembers.backendServerId, proxyId: schema.networkMembers.proxyServerId, proxyName: schema.servers.name })
          .from(schema.networkMembers)
          .innerJoin(schema.servers, eq(schema.servers.id, schema.networkMembers.proxyServerId))
          .where(inArray(schema.networkMembers.backendServerId, list.map((b) => b.server.id)))
      : [];
    const names = suggestNames(list.map((b) => ({ uuid: b.server.uuid, name: b.server.name })));
    return Promise.all(
      list.map(async (b) => {
        const t = taken.find((x) => x.backend === b.server.id && x.proxyId !== p.server.id);
        return {
          uuid: b.server.uuid,
          name: b.server.name,
          templateName: b.template.name,
          address: await allocationAddress(b),
          ownerName: b.owner.name,
          suggestedName: names.get(b.server.uuid)!,
          takenBy: t?.proxyName ?? null,
        };
      }),
    );
  },

  updateNetwork: async ({ input, ctx }) => {
    const { bundle: proxy } = await proxyAccess(ctx, input.uuid);
    const uid = ctx.session!.userId;
    const db = getDb();

    // ---- valideren ----
    const wanted = [...input.members].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    if (wanted.length && wanted.filter((m) => m.isDefault).length !== 1) throw bad("NETWORK_NEEDS_ONE_DEFAULT");
    if (new Set(wanted.map((m) => m.serverUuid)).size !== wanted.length) throw bad("NETWORK_DUPLICATE_SERVER");
    if (new Set(wanted.map((m) => m.name)).size !== wanted.length) throw bad("NETWORK_DUPLICATE_NAME");
    if (wanted.some((m) => m.name === "try" || m.serverUuid === proxy.server.uuid)) throw bad("NETWORK_INVALID_MEMBER");
    const members: Array<{ b: ServerBundle; name: string }> = [];
    for (const w of wanted) {
      const b = await fetchServerByUuid(w.serverUuid);
      if (!b) throw bad("SERVER_NOT_FOUND", "NOT_FOUND");
      if (b.server.ownerId !== uid && !isFullAdmin(ctx)) throw bad("NO_ACCESS", "FORBIDDEN");
      if (!isBackend(b)) throw bad(`NOT_A_BACKEND: ${b.server.name}`);
      if (b.node.id !== proxy.node.id) throw bad(`BACKEND_OTHER_NODE: ${b.server.name}`);
      if (!b.allocations[0]) throw bad(`NO_ALLOCATION: ${b.server.name}`, "PRECONDITION_FAILED");
      const [other] = await db
        .select({ name: schema.servers.name })
        .from(schema.networkMembers)
        .innerJoin(schema.servers, eq(schema.servers.id, schema.networkMembers.proxyServerId))
        .where(and(eq(schema.networkMembers.backendServerId, b.server.id), ne(schema.networkMembers.proxyServerId, proxy.server.id)));
      if (other) throw bad(`ALREADY_IN_NETWORK: ${b.server.name} (${other.name})`, "CONFLICT");
      members.push({ b, name: w.name });
    }
    const previous = await proxyMembers(proxy.server.id);
    const removed = previous.map((x) => x.b).filter((b) => !members.some((m) => m.b.server.id === b.server.id));

    // ---- forced hosts: weggelaten = de bestaande houden (zonder die van verwijderde leden) ----
    const memberId = (uuid: string) => members.find((m) => m.b.server.uuid === uuid)?.b.server.id;
    const forced: Array<{ hostname: string; backendId: number }> = [];
    if (input.forcedHosts) {
      for (const f of input.forcedHosts) {
        const hostname = f.hostname.toLowerCase();
        if (forced.some((x) => x.hostname === hostname)) throw bad(`FORCED_HOST_DUPLICATE: ${hostname}`);
        const id = memberId(f.serverUuid);
        if (!id) throw bad(`FORCED_HOST_NOT_MEMBER: ${hostname}`);
        forced.push({ hostname, backendId: id });
      }
      if (forced.length) {
        const names = forced.map((f) => f.hostname);
        const [other] = await db
          .select({ hostname: schema.networkForcedHosts.hostname })
          .from(schema.networkForcedHosts)
          .where(and(inArray(schema.networkForcedHosts.hostname, names), ne(schema.networkForcedHosts.proxyServerId, proxy.server.id)));
        if (other) throw bad(`FORCED_HOST_TAKEN: ${other.hostname}`, "CONFLICT");
        // Een minecraft- of webdomein van een server buiten dit netwerk hoort niet bij deze proxy.
        const inNet = new Set([proxy.server.id, ...members.map((m) => m.b.server.id)]);
        const doms = await db.select({ hostname: schema.domains.hostname, serverId: schema.domains.serverId }).from(schema.domains).where(inArray(schema.domains.hostname, names));
        const foreign = doms.find((d) => !inNet.has(d.serverId));
        if (foreign) throw bad(`FORCED_HOST_TAKEN: ${foreign.hostname}`, "CONFLICT");
      }
    } else {
      const ids = new Set(members.map((m) => m.b.server.id));
      for (const r of await forcedHostsOf(proxy.server.id)) if (ids.has(r.backendId)) forced.push({ hostname: r.hostname, backendId: r.backendId });
    }
    const tomlForced = tomlForcedHosts(forced, members.map((m) => ({ backendId: m.b.server.id, name: m.name })));

    // ---- forwarding-secret van de proxy ----
    const proxyVars = await serverVariables(proxy.server.id);
    const stored = proxyVars[PROXY_SECRET_VAR] ?? proxy.template.variables.find((v) => v.key === PROXY_SECRET_VAR)?.default ?? "";
    const secret = stored || randomBytes(24).toString("base64url");

    // ---- configuratie op de daemon; mislukt iets, dan stopt het hier (opnieuw opslaan is veilig) ----
    if (secret !== stored) await setVariables(proxy, { [PROXY_SECRET_VAR]: secret });
    const d = daemonFor(proxy.node);
    let toml: string;
    try {
      toml = await d.readFile(proxy.server.uuid, TOML_PATH);
    } catch (e) {
      if (e instanceof DaemonHttpError && e.status === 404) throw bad("PROXY_NOT_INSTALLED: velocity.toml not found, wait for the installation to finish", "PRECONDITION_FAILED");
      throw await call(() => Promise.reject(e));
    }
    // Gedeeld Docker-netwerk van proxy + backends (servers zitten verder elk op een eigen netwerk).
    const addrs = await call(() => memberAddresses(proxy, members.map((m) => m.b)));
    for (const m of members) if (!addrs.get(m.b.server.uuid)) throw bad(`NO_ALLOCATION: ${m.b.server.name}`, "PRECONDITION_FAILED");
    const modernBefore = /^\s*player-info-forwarding-mode\s*=\s*"modern"/m.test(toml);
    await call(() => d.writeFile(proxy.server.uuid, TOML_PATH, applyNetworkToml(toml, members.map((m) => ({ name: m.name, address: addrs.get(m.b.server.uuid)! })), tomlForced)));
    // Alleen backends waarvan de forwarding-variabelen echt veranderen worden aangeraakt (en herstart).
    const changed = new Set<number>();
    for (const m of members) {
      const cur = await serverVariables(m.b.server.id);
      if (cur[FORWARDING_VAR] === "true" && cur[SECRET_VAR] === secret) continue;
      await setVariables(m.b, { [FORWARDING_VAR]: "true", [SECRET_VAR]: secret });
      changed.add(m.b.server.id);
    }
    // Velocity leest secret en forwarding-modus alleen bij de start; de rest (servers, try) kan live herladen.
    const proxyNeedsRestart = secret !== stored || !modernBefore;
    for (const b of removed) await setVariables(b, { [FORWARDING_VAR]: "false", [SECRET_VAR]: "" });

    await db.transaction(async (tx) => {
      await tx.delete(schema.networkMembers).where(eq(schema.networkMembers.proxyServerId, proxy.server.id));
      if (members.length) await tx.insert(schema.networkMembers).values(members.map((m, position) => ({ proxyServerId: proxy.server.id, backendServerId: m.b.server.id, name: m.name, position })));
      await tx.delete(schema.networkForcedHosts).where(eq(schema.networkForcedHosts.proxyServerId, proxy.server.id));
      if (forced.length) await tx.insert(schema.networkForcedHosts).values(forced.map((f) => ({ proxyServerId: proxy.server.id, hostname: f.hostname, backendServerId: f.backendId })));
    });
    await logActivity({
      action: "server.network.update",
      userId: uid,
      serverId: proxy.server.id,
      metadata: { members: members.map((m) => ({ server: m.b.server.name, serverUuid: m.b.server.uuid, name: m.name })), removed: removed.map((b) => b.server.uuid), forcedHosts: tomlForced, restart: input.restart },
      ip: ctx.ip,
      ctx,
    });
    for (const b of [...members.map((m) => m.b), ...removed]) {
      await logActivity({ action: "server.network.backend", userId: uid, serverId: b.server.id, metadata: { proxy: proxy.server.uuid, inNetwork: members.some((m) => m.b.server.id === b.server.id) }, ip: ctx.ip, ctx });
    }

    // Bedrock (Geyser) aan op de proxy: Floodgate + key.pem naar nieuwe leden, weg bij verwijderde leden.
    const bedrockErrors = await syncBedrockBackends(proxy, removed);

    // ---- herstarten: backends eerst, dan de proxy; alleen servers die draaien (de rest leest het bij de volgende start) ----
    const plan: Array<{ b: ServerBundle; role: NetworkUpdateResult["servers"][number]["role"] }> = [
      ...members.map((m) => ({ b: m.b, role: "backend" as const })),
      ...removed.map((b) => ({ b, role: "removed" as const })),
      { b: proxy, role: "proxy" as const },
    ];
    const servers: NetworkUpdateResult["servers"] = [];
    for (const { b, role } of plan) {
      let restarted = false;
      let reloaded = false;
      let error: string | null = null;
      const touched = role === "proxy" || role === "removed" || changed.has(b.server.id);
      if (input.restart && touched && (await isRunning(b))) {
        try {
          if (role === "proxy" && !proxyNeedsRestart) {
            await call(() => daemonFor(b.node).sendCommands(b.server.uuid, ["velocity reload"]));
            reloaded = true;
          } else {
            await call(() => daemonFor(b.node).power(b.server.uuid, "restart"));
            restarted = true;
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
      servers.push({ uuid: b.server.uuid, name: b.server.name, role, restarted, reloaded, error: error ?? (bedrockErrors.has(b.server.uuid) ? `BEDROCK: ${bedrockErrors.get(b.server.uuid)}` : null) });
    }
    return { servers };
  },
};
