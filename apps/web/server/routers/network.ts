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
import { FORWARDING_VAR, PROXY_SECRET_VAR, SECRET_VAR, allocationAddress, isBackend, isProxy, proxyMembers, suggestNames } from "../network";
import { buildServerSpec } from "../spec";
import { fetchServerByUuid, fetchServers, isFullAdmin, limitsOf, requireServer, serverVariables, sleepOf, type ServerBundle } from "../servers-data";

const TOML_PATH = "/velocity.toml";
const bad = (message: string, code: "BAD_REQUEST" | "FORBIDDEN" | "CONFLICT" | "NOT_FOUND" | "PRECONDITION_FAILED" = "BAD_REQUEST") => new TRPCError({ code, message });

/** Variabelen van een server bijwerken: daemon-spec (zonder install), dan database. Effect bij de volgende start. */
async function setVariables(b: ServerBundle, vars: Record<string, string>) {
  const merged = { ...(await serverVariables(b.server.id)), ...vars };
  const spec = buildServerSpec({ uuid: b.server.uuid, template: b.template, variables: merged, limits: limitsOf(b.server), allocations: b.allocations, skipInstall: true, sleep: sleepOf(b.server) });
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
    const members: Array<{ b: ServerBundle; name: string; address: string }> = [];
    for (const w of wanted) {
      const b = await fetchServerByUuid(w.serverUuid);
      if (!b) throw bad("SERVER_NOT_FOUND", "NOT_FOUND");
      if (b.server.ownerId !== uid && !isFullAdmin(ctx)) throw bad("NO_ACCESS", "FORBIDDEN");
      if (!isBackend(b)) throw bad(`NOT_A_BACKEND: ${b.server.name}`);
      if (b.node.id !== proxy.node.id) throw bad(`BACKEND_OTHER_NODE: ${b.server.name}`);
      const address = await allocationAddress(b);
      if (!address) throw bad(`NO_ALLOCATION: ${b.server.name}`, "PRECONDITION_FAILED");
      const [other] = await db
        .select({ name: schema.servers.name })
        .from(schema.networkMembers)
        .innerJoin(schema.servers, eq(schema.servers.id, schema.networkMembers.proxyServerId))
        .where(and(eq(schema.networkMembers.backendServerId, b.server.id), ne(schema.networkMembers.proxyServerId, proxy.server.id)));
      if (other) throw bad(`ALREADY_IN_NETWORK: ${b.server.name} (${other.name})`, "CONFLICT");
      members.push({ b, name: w.name, address });
    }
    const previous = await proxyMembers(proxy.server.id);
    const removed = previous.map((x) => x.b).filter((b) => !members.some((m) => m.b.server.id === b.server.id));

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
    await call(() => d.writeFile(proxy.server.uuid, TOML_PATH, applyNetworkToml(toml, members.map((m) => ({ name: m.name, address: m.address })))));
    for (const m of members) await setVariables(m.b, { [FORWARDING_VAR]: "true", [SECRET_VAR]: secret });
    for (const b of removed) await setVariables(b, { [FORWARDING_VAR]: "false", [SECRET_VAR]: "" });

    await db.transaction(async (tx) => {
      await tx.delete(schema.networkMembers).where(eq(schema.networkMembers.proxyServerId, proxy.server.id));
      if (members.length) await tx.insert(schema.networkMembers).values(members.map((m, position) => ({ proxyServerId: proxy.server.id, backendServerId: m.b.server.id, name: m.name, position })));
    });
    await logActivity({
      action: "server.network.update",
      userId: uid,
      serverId: proxy.server.id,
      metadata: { members: members.map((m) => ({ server: m.b.server.name, serverUuid: m.b.server.uuid, name: m.name })), removed: removed.map((b) => b.server.uuid), restart: input.restart },
      ip: ctx.ip,
      ctx,
    });
    for (const b of [...members.map((m) => m.b), ...removed]) {
      await logActivity({ action: "server.network.backend", userId: uid, serverId: b.server.id, metadata: { proxy: proxy.server.uuid, inNetwork: members.some((m) => m.b.server.id === b.server.id) }, ip: ctx.ip, ctx });
    }

    // ---- herstarten: backends eerst, dan de proxy; alleen servers die draaien (de rest leest het bij de volgende start) ----
    const plan: Array<{ b: ServerBundle; role: NetworkUpdateResult["servers"][number]["role"] }> = [
      ...members.map((m) => ({ b: m.b, role: "backend" as const })),
      ...removed.map((b) => ({ b, role: "removed" as const })),
      { b: proxy, role: "proxy" as const },
    ];
    const servers: NetworkUpdateResult["servers"] = [];
    for (const { b, role } of plan) {
      let restarted = false;
      let error: string | null = null;
      if (input.restart && (await isRunning(b))) {
        try {
          await call(() => daemonFor(b.node).power(b.server.uuid, "restart"));
          restarted = true;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
      servers.push({ uuid: b.server.uuid, name: b.server.name, role, restarted, error });
    }
    return { servers };
  },
};
