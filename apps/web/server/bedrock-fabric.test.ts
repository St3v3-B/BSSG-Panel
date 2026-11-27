import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { mockExternal, type Handler } from "./test/external-fake";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const tpl = (n: string) => readFileSync(join(__dirname, "../../../templates/game", n), "utf8");
const h = useHarness({ env: { NODE_PUBLIC_IP: "203.0.113.10" }, templates: { "game/paper.yaml": tpl("paper.yaml"), "game/velocity.yaml": tpl("velocity.yaml"), "game/fabric.yaml": tpl("fabric.yaml") } });
const limits = { cpuPct: 100, ramMb: 1536, swapMb: 0, diskMb: 1024 };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const sha512 = (s: string) => createHash("sha512").update(s).digest("hex");

// ---- nep Modrinth (Fabric-mods per Minecraft-versie) en GeyserMC (Velocity-proxy) ----
const MODS: Record<string, { id: string; title: string }> = { geyser: { id: "wKkoqHrH", title: "Geyser" }, floodgate: { id: "bWrNNfkb", title: "Floodgate" }, "fabric-api": { id: "P7dR8mSH", title: "Fabric API" } };
const SUPPORTED = ["1.21.4", "1.21.11"];
const body = (slug: string, mc: string) => `jar-${slug}-fabric-${mc}`;
let tamper = false;
const world: Handler = (url) => {
  if (url.hostname === "api.modrinth.com") {
    const pm = /^\/v2\/project\/([a-z-]+)$/.exec(url.pathname);
    if (pm) return MODS[pm[1]!] ? { json: { id: MODS[pm[1]!]!.id, slug: pm[1], title: MODS[pm[1]!]!.title, description: "", downloads: 1, icon_url: null } } : { status: 404 };
    const vm = /^\/v2\/project\/([a-z-]+)\/version$/.exec(url.pathname);
    if (!vm || !MODS[vm[1]!]) return { status: 404 };
    const slug = vm[1]!;
    const loaders = JSON.parse(url.searchParams.get("loaders") ?? "[]") as string[];
    const [mc] = JSON.parse(url.searchParams.get("game_versions") ?? "[]") as string[];
    if (!loaders.includes("fabric") || !mc || !SUPPORTED.includes(mc)) return { json: [] };
    const filename = slug === "fabric-api" ? `fabric-api-0.119.0+${mc}.jar` : `${slug === "geyser" ? "Geyser-Fabric" : "floodgate-fabric"}-${mc}.jar`;
    return {
      json: [{ id: `${slug}-${mc}`, project_id: MODS[slug]!.id, version_number: `2.0.0+${mc}`, version_type: "release", loaders: ["fabric"], game_versions: [mc], dependencies: [], files: [{ hashes: { sha512: sha512(body(slug, mc)) }, url: `https://cdn.modrinth.com/data/${MODS[slug]!.id}/${filename}`, filename, primary: true, size: 10 }] }],
    };
  }
  if (url.hostname === "cdn.modrinth.com") {
    const m = /^\/data\/(\w+)\/(.+)$/.exec(url.pathname);
    const slug = Object.keys(MODS).find((k) => MODS[k]!.id === m?.[1]);
    const mc = /-([0-9.]+)\.jar$/.exec(decodeURIComponent(m?.[2] ?? ""))?.[1] ?? /\+([0-9.]+)\.jar$/.exec(decodeURIComponent(m?.[2] ?? ""))?.[1];
    return slug && mc ? { body: tamper ? "tampered" : body(slug, mc) } : { status: 404 };
  }
  if (url.hostname === "download.geysermc.org") {
    const m = /^\/v2\/projects\/(geyser|floodgate)\/versions\/latest\/builds\/latest(?:\/downloads\/(spigot|velocity))?$/.exec(url.pathname);
    if (!m) return { status: 404 };
    const [, project, platform] = m;
    if (platform) return { body: `jar-${project}-${platform}` };
    const downloads = Object.fromEntries(["spigot", "velocity"].map((p) => [p, { name: `${project === "geyser" ? "Geyser" : "floodgate"}-${p}.jar`, sha256: sha256(`jar-${project}-${p}`) }]));
    return { json: { version: "2.12.1", build: 1312, downloads } };
  }
  return undefined;
};

let ext: ReturnType<typeof mockExternal>;
let admin: TestUser, alice: TestUser, bob: TestUser;
let fab = "", old = "", proxy = "", fabBackend = "", paperBackend = "";
const files = (u: string) => h.daemon.fs(u).files;
const create = async (name: string, slug: string, port: number, variables: Record<string, string> = {}) =>
  (await admin.api.admin.servers.create({ name, ownerId: alice.id, nodeId: h.localNodeId, templateId: await h.templateId(slug), limits, allocationIds: [await h.allocation(port)], variables, startOnInstall: false })).uuid;
const content = async (uuid: string) => {
  const [s] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid));
  return getDb().select().from(schema.serverContent).where(eq(schema.serverContent.serverId, s!.id));
};
const modrinthCalls = () => ext.calls.filter((c) => c.url.includes("api.modrinth.com") && c.url.includes("/version?"));

beforeAll(async () => {
  ext = mockExternal(world);
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  alice = await h.user({ discordId: "200100000000000071", name: "alice" });
  bob = await h.user({ discordId: "200200000000000072", name: "bob" });
  fab = await create("Fab", "fabric", 36301);
  old = await create("Old Fab", "fabric", 36302, { MINECRAFT_VERSION: "1.8.9" });
  proxy = await create("Proxy", "velocity", 36303);
  fabBackend = await create("Fab Backend", "fabric", 36304, { MINECRAFT_VERSION: "1.21.11" });
  paperBackend = await create("Paper Backend", "paper", 36305);
  for (const u of [fab, old, fabBackend]) h.daemon.fs(u).dirs.add("/mods");
  // Wat de installatie vastlegt wint van de variabele (`latest`).
  files(fab).set("/.fabric-install", "minecraft=1.21.4\nloader=0.16.10\ninstaller=1.0.1\n");
  for (const p of [19132, 36310, 36311, 36312]) await h.allocation(p);
});
afterAll(() => ext.restore());

describe("Bedrock op Fabric (Geyser-Fabric + Floodgate-Fabric via Modrinth)", () => {
  it("ondersteund als standalone; vreemden mogen niets", async () => {
    expect(await alice.api.servers.bedrock({ uuid: fab })).toMatchObject({ supported: true, mode: "standalone", enabled: false });
    await expect(bob.api.servers.setBedrock({ uuid: fab, enabled: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("geen versie voor deze Minecraft-versie: duidelijke fout, niets gewijzigd", async () => {
    await expect(alice.api.servers.setBedrock({ uuid: old, enabled: true })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/^BEDROCK_NO_COMPATIBLE_VERSION: .*1\.8\.9/) });
    expect([...files(old).keys()].filter((f) => f.startsWith("/mods/"))).toEqual([]);
    expect((await alice.api.servers.bedrock({ uuid: old })).enabled).toBe(false);
  });

  it("hash-controle (sha512 van Modrinth): afwijking weigert en wijzigt niets", async () => {
    tamper = true;
    await expect(alice.api.servers.setBedrock({ uuid: fab, enabled: true })).rejects.toThrow(/HASH_MISMATCH/);
    tamper = false;
    expect(files(fab).has("/mods/Geyser-Fabric.jar")).toBe(false);
    expect((await getDb().select().from(schema.allocations).where(eq(schema.allocations.port, 19132)))[0]!.serverId).toBeNull();
  });

  it("aanzetten: mods bij de geïnstalleerde Minecraft-versie, Fabric API, config en UDP-allocation", async () => {
    ext.calls.length = 0;
    const r = await alice.api.servers.setBedrock({ uuid: fab, enabled: true });
    expect(r).toMatchObject({ supported: true, mode: "standalone", enabled: true, port: 19132 });
    expect(files(fab).get("/mods/Geyser-Fabric.jar")).toBe(body("geyser", "1.21.4"));
    expect(files(fab).get("/mods/floodgate-fabric.jar")).toBe(body("floodgate", "1.21.4"));
    expect(files(fab).get("/mods/fabric-api-0.119.0+1.21.4.jar")).toBe(body("fabric-api", "1.21.4"));
    expect(modrinthCalls().every((c) => decodeURIComponent(c.url).includes('game_versions=["1.21.4"]') && decodeURIComponent(c.url).includes('loaders=["fabric"]'))).toBe(true);
    expect(modrinthCalls()).toHaveLength(3);
    const cfg = files(fab).get("/config/Geyser-Fabric/config.yml")!;
    expect(cfg).toContain("port: 19132");
    expect(cfg).toContain("port: 36301");
    expect(cfg).toContain("auth-type: floodgate");
    expect(files(fab).has("/plugins/Geyser-Spigot.jar")).toBe(false);
    expect(h.daemon.servers.get(fab)!.spec.allocations.map((a) => a.port).sort()).toEqual([19132, 36301]);
    // Fabric API staat als mod in de Mods-tab (bij te werken / te verwijderen)
    expect((await content(fab)).map((c) => [c.name, c.projectId, c.filename, c.kind])).toEqual([["Fabric API", "P7dR8mSH", "fabric-api-0.119.0+1.21.4.jar", "mod"]]);
    const [log] = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "server.bedrock.enable"));
    expect(log!.metadata).toMatchObject({ platform: "fabric", geyser: "2.0.0+1.21.4" });
  });

  it("opnieuw aanzetten: Fabric API staat er al en wordt niet nog eens gehaald", async () => {
    ext.calls.length = 0;
    await alice.api.servers.setBedrock({ uuid: fab, enabled: true });
    expect(modrinthCalls().map((c) => c.url)).not.toEqual(expect.arrayContaining([expect.stringContaining("fabric-api")]));
    expect(modrinthCalls()).toHaveLength(2);
  });

  it("uitzetten: Geyser en Floodgate weg, Fabric API blijft, poort vrij", async () => {
    const r = await alice.api.servers.setBedrock({ uuid: fab, enabled: false });
    expect(r).toMatchObject({ enabled: false, port: null });
    expect(files(fab).has("/mods/Geyser-Fabric.jar")).toBe(false);
    expect(files(fab).has("/mods/floodgate-fabric.jar")).toBe(false);
    expect(files(fab).has("/mods/fabric-api-0.119.0+1.21.4.jar")).toBe(true);
    expect(h.daemon.servers.get(fab)!.spec.allocations.map((a) => a.port)).toEqual([36301]);
  });

  it("Fabric-backend achter Velocity: Floodgate-Fabric + Fabric API + dezelfde key.pem; weg bij uitzetten", async () => {
    files(proxy).set("/velocity.toml", 'bind = "0.0.0.0:25577"\n[servers]\ntry = []\n');
    await alice.api.servers.updateNetwork({ uuid: proxy, members: [{ serverUuid: paperBackend, name: "paper", isDefault: true }, { serverUuid: fabBackend, name: "fabric", isDefault: false }], restart: false });
    expect((await alice.api.servers.bedrock({ uuid: fabBackend })).mode).toBe("backend");
    await expect(alice.api.servers.setBedrock({ uuid: fabBackend, enabled: true })).rejects.toThrow(/BEDROCK_VIA_PROXY/);

    await alice.api.servers.setBedrock({ uuid: proxy, enabled: true });
    const key = files(proxy).get("/plugins/floodgate/key.pem")!;
    expect(key).toBeTruthy();
    // Paper-backend: spigot-plugin; Fabric-backend: mod bij zijn eigen Minecraft-versie, key onder config/
    expect(files(paperBackend).get("/plugins/floodgate-spigot.jar")).toBe("jar-floodgate-spigot");
    expect(files(paperBackend).get("/plugins/floodgate/key.pem")).toBe(key);
    expect(files(fabBackend).get("/mods/floodgate-fabric.jar")).toBe(body("floodgate", "1.21.11"));
    expect(files(fabBackend).get("/mods/fabric-api-0.119.0+1.21.11.jar")).toBe(body("fabric-api", "1.21.11"));
    expect(files(fabBackend).get("/config/floodgate/key.pem")).toBe(key);
    expect(files(fabBackend).has("/mods/Geyser-Fabric.jar")).toBe(false); // Geyser alleen op de proxy
    expect(files(fabBackend).has("/plugins/floodgate-spigot.jar")).toBe(false);

    await alice.api.servers.setBedrock({ uuid: proxy, enabled: false });
    expect(files(fabBackend).has("/mods/floodgate-fabric.jar")).toBe(false);
    expect(files(paperBackend).has("/plugins/floodgate-spigot.jar")).toBe(false);
    const [s] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, fabBackend));
    expect(await getDb().select().from(schema.serverContent).where(and(eq(schema.serverContent.serverId, s!.id), eq(schema.serverContent.projectId, "P7dR8mSH")))).toHaveLength(1);
  });
});
