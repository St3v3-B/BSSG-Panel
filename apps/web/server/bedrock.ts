/**
 * Bedrock (Geyser + Floodgate) voor Paper/Folia/Velocity/Fabric: aan- en uitzetten, poorttoewijzing en
 * het Velocity-netwerk (Floodgate + gedeelde key.pem op de backends). Procedures: `servers.bedrock/setBedrock`.
 * Fabric: Geyser-Fabric + Floodgate-Fabric in `mods/` uit Modrinth bij de Minecraft-versie, plus Fabric API
 * als die er nog niet is (blijft staan bij uitzetten: andere mods kunnen hem nodig hebben).
 */
import { bedrockPlatform, type BedrockStatus, type Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { logActivity } from "./activity";
import { DaemonHttpError, call, daemonFor } from "./daemon";
import { getDb, schema } from "./db";
import { ExternalError } from "./lib/http";
import { DEFAULT_BEDROCK_PORT, FLOODGATE_KEY_PATH, downloadFabricMod, downloadGeyserJar, floodgateKeyPath, geyserConfig, geyserConfigPath, jarPath, newFloodgateKey, type GeyserJar, type GeyserPlatform } from "./lib/geyser";
import { latestGameVersion } from "./lib/mc-versions";
import { isBackend, isProxy, proxyMembers } from "./network";
import { nodeIp } from "./routers/domains";
import { buildServerSpec } from "./spec";
import { fetchServerByUuid, limitsOf, requireServer, serverVariables, sleepOf, type ServerBundle } from "./servers-data";

const bad = (message: string, code: "BAD_REQUEST" | "CONFLICT" | "PRECONDITION_FAILED" | "BAD_GATEWAY" = "BAD_REQUEST") => new TRPCError({ code, message });
const platformOf = (b: ServerBundle) => (b.server.type === "game" ? bedrockPlatform(b.template.slug) : null);

/** De Bedrock-allocation van de server (alleen geldig zolang hij nog bij deze server hoort). */
export const bedrockAllocation = (b: ServerBundle) => b.allocations.find((a) => a.id === b.server.bedrockAllocationId) ?? null;

async function isBehindProxy(b: ServerBundle): Promise<boolean> {
  const [m] = await getDb().select({ id: schema.networkMembers.proxyServerId }).from(schema.networkMembers).where(eq(schema.networkMembers.backendServerId, b.server.id));
  return !!m;
}

/** Spelers verbinden met het IP van de allocation (0.0.0.0 = publiek IP van de node). Bedrock kent geen SRV, dus geen domein. */
async function publicHost(b: ServerBundle, ip: string): Promise<string> {
  if (ip !== "0.0.0.0") return ip;
  try {
    return await nodeIp(b.node);
  } catch {
    return b.node.fqdn;
  }
}

export async function bedrockStatus(b: ServerBundle): Promise<BedrockStatus> {
  const platform = platformOf(b);
  const proxy = isProxy(b);
  const backend = !proxy && !!platform && (await isBehindProxy(b));
  const supported = !!platform && !backend;
  const mode = proxy ? "proxy" : backend ? "backend" : "standalone";
  const a = supported ? bedrockAllocation(b) : null;
  let free: BedrockStatus["freeAllocations"] = [];
  if (supported) {
    const primary = b.allocations[0];
    const rows = await getDb().select().from(schema.allocations).where(and(eq(schema.allocations.nodeId, b.node.id), isNull(schema.allocations.serverId))).orderBy(asc(schema.allocations.port));
    free = rows
      .filter((r) => !primary || r.ip === primary.ip)
      .sort((x, y) => Number(y.port === DEFAULT_BEDROCK_PORT) - Number(x.port === DEFAULT_BEDROCK_PORT) || x.port - y.port)
      .map((r) => ({ id: r.id, ip: r.ip, port: r.port }));
  }
  return { supported, mode, enabled: !!a, address: a ? await publicHost(b, a.ip) : null, port: a?.port ?? null, allocationId: a?.id ?? null, freeAllocations: free };
}

async function pushSpec(b: ServerBundle, allocations: Array<{ ip: string; port: number; isPrimary: boolean }>) {
  const spec = buildServerSpec({ uuid: b.server.uuid, template: b.template, variables: await serverVariables(b.server.id), limits: limitsOf(b.server), allocations, skipInstall: true, sleep: sleepOf(b.server) });
  await call(() => daemonFor(b.node).updateServer(b.server.uuid, spec));
}

async function remove(b: ServerBundle, paths: string[]) {
  await call(() => daemonFor(b.node).deleteFiles(b.server.uuid, paths)).catch((e) => {
    if (!(e instanceof DaemonHttpError && e.status === 404)) throw e;
  });
}

// ---------- Fabric ----------

const MC_VERSION = /^[0-9]+(\.[0-9]+){1,2}$/;

/** Minecraft-versie van een Fabric-server: wat de installatie vastlegde (.fabric-install), anders de variabele of de nieuwste. */
export async function fabricGameVersion(b: ServerBundle): Promise<string> {
  try {
    const m = /^minecraft=(\S+)$/m.exec(await daemonFor(b.node).readFile(b.server.uuid, "/.fabric-install"));
    if (m && MC_VERSION.test(m[1]!)) return m[1]!;
  } catch {
    // nog niet geïnstalleerd of daemon weg: variabele
  }
  const v = ((await serverVariables(b.server.id)).MINECRAFT_VERSION ?? b.template.variables.find((x) => x.key === "MINECRAFT_VERSION")?.default ?? "latest").trim();
  if (MC_VERSION.test(v)) return v;
  const latest = await latestGameVersion("fabric");
  if (!latest) throw new ExternalError("EXTERNAL_BAD_RESPONSE", "no Minecraft version in the Fabric meta API");
  return latest;
}

/** Staat er al een Fabric API in `mods/` (via de Mods-tab, een modpack of zelf geüpload)? */
async function hasFabricApi(b: ServerBundle): Promise<boolean> {
  try {
    const list = await daemonFor(b.node).listFiles(b.server.uuid, "/mods");
    return list.some((f) => /^fabric-api[-_.].*\.jar$/i.test(f.name));
  } catch {
    return false;
  }
}

/** Zet Fabric API neer en registreert hem als geïnstalleerde mod (zichtbaar en bij te werken in de Mods-tab). */
async function placeFabricApi(b: ServerBundle, jar: GeyserJar) {
  await call(() => daemonFor(b.node).writeFile(b.server.uuid, `/mods/${jar.filename}`, jar.data));
  const values = { serverId: b.server.id, source: "modrinth", projectId: jar.projectId!, name: jar.name ?? "Fabric API", versionId: jar.versionId!, versionNumber: jar.version, filename: jar.filename, kind: "mod" };
  await getDb()
    .insert(schema.serverContent)
    .values(values)
    .onConflictDoUpdate({ target: [schema.serverContent.serverId, schema.serverContent.source, schema.serverContent.projectId], set: { versionId: values.versionId, versionNumber: values.versionNumber, filename: values.filename, installedAt: new Date() } });
}

/** Downloads per Minecraft-versie, één keer per aanroep (proxy met meerdere Fabric-backends). */
function fabricDownloads() {
  const cache = new Map<string, Promise<GeyserJar>>();
  return (mod: "geyser" | "floodgate" | "fabric-api", mc: string) => {
    const k = `${mod}@${mc}`;
    if (!cache.has(k)) cache.set(k, downloadFabricMod(mod, mc));
    return cache.get(k)!;
  };
}

/** Floodgate op een backend achter Velocity: jar + de key.pem van de proxy (Fabric: ook Fabric API indien nodig). */
async function installFloodgateBackend(b: ServerBundle, key: Buffer, get: { spigot: () => Promise<GeyserJar>; fabric: ReturnType<typeof fabricDownloads> }) {
  const p = platformOf(b);
  const d = daemonFor(b.node);
  if (p === "fabric") {
    const mc = await fabricGameVersion(b);
    const needApi = !(await hasFabricApi(b));
    const [jar, api] = await Promise.all([get.fabric("floodgate", mc), needApi ? get.fabric("fabric-api", mc) : null]);
    await call(() => d.writeFile(b.server.uuid, jarPath("floodgate", "fabric"), jar.data));
    if (api) await placeFabricApi(b, api);
  } else {
    const jar = await get.spigot();
    await call(() => d.writeFile(b.server.uuid, jarPath("floodgate", "spigot"), jar.data));
  }
  await call(() => d.writeFile(b.server.uuid, floodgateKeyPath(p ?? "spigot"), key));
}
const removeFloodgateBackend = (b: ServerBundle) => remove(b, [jarPath("floodgate", platformOf(b) === "fabric" ? "fabric" : "spigot")]);

/**
 * Houdt de backends van een proxy in lijn met de Bedrock-stand van de proxy: met Bedrock aan krijgen leden
 * Floodgate en dezelfde key.pem, verwijderde leden (of alles bij uitzetten) verliezen hem. Geeft fouten per server terug.
 */
export async function syncBedrockBackends(proxy: ServerBundle, removed: ServerBundle[] = [], opts: { disabling?: boolean } = {}): Promise<Map<string, string>> {
  const errors = new Map<string, string>();
  const on = !opts.disabling && !!bedrockAllocation(proxy);
  const members = (await proxyMembers(proxy.server.id)).map((x) => x.b).filter(isBackend);
  const run = async (b: ServerBundle, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      errors.set(b.server.uuid, e instanceof Error ? e.message : String(e));
    }
  };
  for (const b of removed) await run(b, () => removeFloodgateBackend(b));
  if (!on) {
    for (const b of members) await run(b, () => removeFloodgateBackend(b));
    return errors;
  }
  if (!members.length) return errors;
  let key: Buffer;
  try {
    key = await daemonFor(proxy.node).readFileBytes(proxy.server.uuid, FLOODGATE_KEY_PATH);
  } catch (e) {
    for (const b of members) errors.set(b.server.uuid, e instanceof Error ? e.message : String(e));
    return errors;
  }
  let spigot: Promise<GeyserJar> | null = null;
  const get = { spigot: () => (spigot ??= downloadGeyserJar("floodgate", "spigot")), fabric: fabricDownloads() };
  for (const b of members) await run(b, () => installFloodgateBackend(b, key, get));
  return errors;
}

async function isRunning(b: ServerBundle): Promise<boolean> {
  try {
    const st = await daemonFor(b.node).getServer(b.server.uuid, 2000);
    return st.state === "online" || st.state === "starting";
  } catch {
    return false;
  }
}

/** Kiest de allocation voor Bedrock: de opgegeven, anders 19132 of de eerste vrije op het IP van de primaire poort. */
function pickAllocation(status: BedrockStatus, wanted: number | undefined) {
  if (wanted !== undefined) {
    const f = status.freeAllocations.find((x) => x.id === wanted);
    if (!f) throw bad("ALLOCATION_NOT_AVAILABLE", "CONFLICT");
    return f;
  }
  const f = status.freeAllocations[0];
  if (!f) throw bad("NO_FREE_ALLOCATIONS", "PRECONDITION_FAILED");
  return f;
}

export const bedrock: Pick<Implementation["servers"], "bedrock" | "setBedrock"> = {
  bedrock: async ({ input, ctx }) => bedrockStatus((await requireServer(ctx, input.uuid, "any")).bundle),

  setBedrock: async ({ input, ctx }) => {
    const { bundle: b } = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    const platform = platformOf(b);
    const status = await bedrockStatus(b);
    if (!platform || !status.supported) throw bad(status.mode === "backend" ? "BEDROCK_VIA_PROXY" : "BEDROCK_NOT_SUPPORTED");
    const uid = ctx.session!.userId;
    const db = getDb();
    const d = daemonFor(b.node);
    const proxy = isProxy(b);
    const current = bedrockAllocation(b);

    if (!input.enabled) {
      if (current) {
        await remove(b, [jarPath("geyser", platform), jarPath("floodgate", platform)]);
        await db.transaction(async (tx) => {
          await tx.update(schema.allocations).set({ serverId: null, isPrimary: false }).where(eq(schema.allocations.id, current.id));
          await tx.update(schema.servers).set({ bedrockAllocationId: null }).where(eq(schema.servers.id, b.server.id));
        });
        await pushSpec(b, b.allocations.filter((a) => a.id !== current.id));
        if (proxy) await syncBedrockBackends(b, [], { disabling: true });
        await logActivity({ action: "server.bedrock.disable", userId: uid, serverId: b.server.id, metadata: { port: current.port }, ip: ctx.ip, ctx });
      }
      return bedrockStatus((await fetchServerByUuid(b.server.uuid))!);
    }

    // ---- aanzetten: eerst alles ophalen en controleren, pas daarna iets wijzigen ----
    const target = input.allocationId !== undefined && current && input.allocationId === current.id ? { id: current.id, ip: current.ip, port: current.port } : current && input.allocationId === undefined ? { id: current.id, ip: current.ip, port: current.port } : pickAllocation(status, input.allocationId);
    const primary = b.allocations[0];
    if (!primary) throw bad("NO_ALLOCATION", "PRECONDITION_FAILED");
    let geyser: GeyserJar;
    let floodgate: GeyserJar;
    let fabricApi: GeyserJar | null = null;
    try {
      if (platform === "fabric") {
        const mc = await fabricGameVersion(b);
        const needApi = !(await hasFabricApi(b));
        [geyser, floodgate, fabricApi] = await Promise.all([downloadFabricMod("geyser", mc), downloadFabricMod("floodgate", mc), needApi ? downloadFabricMod("fabric-api", mc) : null]);
      } else {
        [geyser, floodgate] = await Promise.all([downloadGeyserJar("geyser", platform), downloadGeyserJar("floodgate", platform)]);
      }
    } catch (e) {
      if (e instanceof ExternalError) {
        const nc = /NO_COMPATIBLE_VERSION: (.*)$/.exec(e.message);
        if (nc) throw bad(`BEDROCK_NO_COMPATIBLE_VERSION: ${nc[1]}`);
        throw new TRPCError({ code: e.code === "HASH_MISMATCH" ? "BAD_REQUEST" : "BAD_GATEWAY", message: e.message });
      }
      throw e;
    }
    if (!current || current.id !== target.id) {
      const claimed = await db.transaction(async (tx) => {
        const [got] = await tx.update(schema.allocations).set({ serverId: b.server.id, isPrimary: false }).where(and(eq(schema.allocations.id, target.id), isNull(schema.allocations.serverId))).returning({ id: schema.allocations.id });
        if (!got) return false;
        if (current) await tx.update(schema.allocations).set({ serverId: null, isPrimary: false }).where(eq(schema.allocations.id, current.id));
        await tx.update(schema.servers).set({ bedrockAllocationId: target.id }).where(eq(schema.servers.id, b.server.id));
        return true;
      });
      if (!claimed) throw bad("ALLOCATION_NOT_AVAILABLE", "CONFLICT");
    }
    const spec = [...b.allocations.filter((a) => a.id !== current?.id), { ip: target.ip, port: target.port, isPrimary: false }];
    await pushSpec(b, spec);
    await call(() => d.writeFile(b.server.uuid, jarPath("geyser", platform), geyser.data));
    await call(() => d.writeFile(b.server.uuid, jarPath("floodgate", platform), floodgate.data));
    if (fabricApi) await placeFabricApi(b, fabricApi);
    await call(() => d.writeFile(b.server.uuid, geyserConfigPath(platform as GeyserPlatform), geyserConfig({ port: target.port, javaPort: primary.port })));
    if (proxy) {
      // Eén sleutel voor proxy en backends; bestaat hij al (opnieuw aanzetten), dan blijft hij.
      const have = await d.readFileBytes(b.server.uuid, FLOODGATE_KEY_PATH).then((k) => k.length > 0, () => false);
      if (!have) await call(() => d.writeFile(b.server.uuid, FLOODGATE_KEY_PATH, newFloodgateKey()));
    }
    const fresh = (await fetchServerByUuid(b.server.uuid))!;
    const errors = proxy ? await syncBedrockBackends(fresh) : new Map<string, string>();
    if (input.restart) {
      const targets = [fresh, ...(proxy ? (await proxyMembers(b.server.id)).map((x) => x.b).filter((x) => !errors.has(x.server.uuid)) : [])];
      for (const t of targets) if (await isRunning(t)) await call(() => daemonFor(t.node).power(t.server.uuid, "restart")).catch(() => {});
    }
    await logActivity({ action: "server.bedrock.enable", userId: uid, serverId: b.server.id, metadata: { port: target.port, platform, geyser: geyser.build ? `${geyser.version}-${geyser.build}` : geyser.version, floodgate: floodgate.build ? `${floodgate.version}-${floodgate.build}` : floodgate.version, fabricApi: fabricApi?.version ?? null, backendErrors: Object.fromEntries(errors) }, ip: ctx.ip, ctx });
    return bedrockStatus(fresh);
  },
};
