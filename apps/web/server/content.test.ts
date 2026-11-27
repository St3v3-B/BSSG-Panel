import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { resetVersionCache } from "./lib/mc-versions";
import { mockExternal, type Handler } from "./test/external-fake";
import { OWNER, useHarness, type TestUser } from "./test/harness";
import { buildZip } from "./test/zip-build";

const tpl = (n: string) => readFileSync(join(__dirname, "../../../templates/game", n), "utf8");
const h = useHarness({ templates: { "game/paper.yaml": tpl("paper.yaml"), "game/fabric.yaml": tpl("fabric.yaml"), "game/velocity.yaml": tpl("velocity.yaml") } });
const limits = { cpuPct: 100, ramMb: 1024, swapMb: 0, diskMb: 1024 };
const sha = (algo: string, s: string | Buffer) => createHash(algo).update(s).digest("hex");

// ---- nep-wereld ----
const jars: Record<string, string> = {
  "/data/LP/versions/v1/LuckPerms-5.4.jar": "jar-lp-v1",
  "/data/LP/versions/v2/LuckPerms-5.5.jar": "jar-lp-v2",
  "/data/VAULT/versions/v1/Vault.jar": "jar-vault",
  "/data/BAD/versions/v1/Bad.jar": "jar-bad-actual",
  "/data/FAB/versions/f1/fabulous.jar": "jar-fab",
};
const mrVersion = (id: string, project: string, filename: string, path: string, content: string, deps: string[] = [], hash = sha("sha512", content)) => ({
  id, project_id: project, version_number: id === "v2" ? "5.5" : "5.4", version_type: "release", loaders: ["paper", "spigot", "fabric"], game_versions: ["1.21.5"],
  files: [{ primary: true, filename, size: content.length, url: `https://cdn.modrinth.com${path}`, hashes: { sha512: hash, sha1: "x" } }],
  dependencies: deps.map((d) => ({ project_id: d, version_id: null, dependency_type: "required" })),
});
let lpLatest = "v2";
const searchUrls: string[] = [];
let extra: Handler = () => undefined;
const world: Handler = (url, init) => {
  const e = extra(url, init);
  if (e) return e;
  const p = url.pathname;
  if (url.hostname === "cdn.modrinth.com") return jars[p] ? { body: jars[p] } : { status: 404 };
  if (url.hostname === "evil.example") return { body: "x" };
  if (url.hostname === "api.modrinth.com") {
    if (p === "/v2/search") {
      searchUrls.push(url.toString());
      return { json: { total_hits: 1, hits: [{ project_id: "LP", slug: "luckperms", title: "LuckPerms", description: "perms", author: "Luck", downloads: 42, icon_url: "https://cdn.modrinth.com/i.png" }] } };
    }
    const proj = /^\/v2\/project\/([A-Z]+)$/.exec(p);
    if (proj) return { json: { id: proj[1], slug: proj[1]!.toLowerCase(), title: ({ LP: "LuckPerms", VAULT: "Vault", BAD: "BadPlugin", FAB: "Fabulous" } as Record<string, string>)[proj[1]!], description: "d", downloads: 1, icon_url: null } };
    if (/\/members$/.test(p)) return { json: [{ role: "Owner", user: { username: "Luck" } }] };
    if (p === "/v2/project/LP/version") return { json: lpLatest === "v2" ? [mrVersion("v2", "LP", "LuckPerms-5.5.jar", "/data/LP/versions/v2/LuckPerms-5.5.jar", "jar-lp-v2", ["VAULT"]), mrVersion("v1", "LP", "LuckPerms-5.4.jar", "/data/LP/versions/v1/LuckPerms-5.4.jar", "jar-lp-v1")] : [mrVersion("v1", "LP", "LuckPerms-5.4.jar", "/data/LP/versions/v1/LuckPerms-5.4.jar", "jar-lp-v1")] };
    if (p === "/v2/project/VAULT/version") return { json: [mrVersion("v1", "VAULT", "Vault.jar", "/data/VAULT/versions/v1/Vault.jar", "jar-vault")] };
    if (p === "/v2/project/BAD/version") return { json: [mrVersion("v1", "BAD", "Bad.jar", "/data/BAD/versions/v1/Bad.jar", "jar-bad-expected")] };
    if (p === "/v2/project/FAB/version") return { json: [mrVersion("f1", "FAB", "fabulous.jar", "/data/FAB/versions/f1/fabulous.jar", "jar-fab")] };
  }
  if (url.hostname === "fill.papermc.io") {
    if (p === "/v3/projects/paper/versions") return { json: { versions: [{ version: { id: "1.21.6-rc1" } }, { version: { id: "1.21.5" } }, { version: { id: "1.21.4" } }] } };
    if (p === "/v3/projects/paper/versions/1.21.5/builds") return { json: [{ id: 100 }, { id: 112 }, { id: 99 }] };
  }
  if (url.hostname === "meta.fabricmc.net") {
    if (p === "/v2/versions/game") return { json: [{ version: "24w14a", stable: false }, { version: "1.21.5", stable: true }, { version: "1.21.4", stable: true }] };
    if (p === "/v2/versions/loader") return { json: [{ version: "0.16.14", stable: true }, { version: "0.16.13", stable: true }] };
  }
  if (url.hostname === "hangar.papermc.io") {
    if (p === "/api/v1/projects") return { json: { pagination: { count: 1 }, result: [{ name: "ViaVersion", namespace: { owner: "ViaVersion", slug: "ViaVersion" }, description: "v", avatarUrl: null, stats: { downloads: 7 } }] } };
    if (p === "/api/v1/projects/ViaVersion") return { json: { name: "ViaVersion", namespace: { owner: "ViaVersion", slug: "ViaVersion" }, description: "v", avatarUrl: null, stats: { downloads: 7 } } };
    if (p === "/api/v1/projects/ViaVersion/versions") return { json: { result: [{ name: "5.0.0", channel: { name: "Release" }, downloads: { PAPER: { fileInfo: { name: "ViaVersion-5.0.0.jar", sizeBytes: 9, sha256Hash: sha("sha256", "jar-via") }, downloadUrl: "https://hangarcdn.papermc.io/plugins/ViaVersion/5.0.0.jar" } } }] } };
    if (p === "/api/v1/projects/ViaVersion/versions/5.0.0/PAPER/download") return { status: 302, headers: { location: "https://hangarcdn.papermc.io/plugins/ViaVersion/5.0.0.jar" } };
  }
  if (url.hostname === "hangarcdn.papermc.io") return { body: "jar-via" };
  return undefined;
};

let ext: ReturnType<typeof mockExternal>;
let admin: TestUser, alice: TestUser, bob: TestUser, sub: TestUser;
let paper = "", fab = "", vel = "", other = "";
const create = async (name: string, owner: TestUser, slug: string, port: number, variables: Record<string, string> = {}) => {
  const a = await h.allocation(port);
  return (await admin.api.admin.servers.create({ name, ownerId: owner.id, nodeId: h.localNodeId, templateId: await h.templateId(slug), limits, allocationIds: [a], variables, startOnInstall: false })).uuid;
};
const files = (uuid: string) => h.daemon.fs(uuid).files;

beforeAll(async () => {
  ext = mockExternal(world);
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  alice = await h.user({ discordId: "290000000000000021", name: "alice" });
  bob = await h.user({ discordId: "290000000000000022", name: "bob" });
  sub = await h.user({ discordId: "290000000000000023", name: "sub" });
  paper = await create("Paper", alice, "paper", 34300, { MINECRAFT_VERSION: "1.21.5" });
  fab = await create("Fab", alice, "fabric", 34301, { MINECRAFT_VERSION: "1.21.5" });
  vel = await create("Vel", alice, "velocity", 34302);
  other = await create("Latest", alice, "paper", 34303);
}, 180_000);
afterAll(() => ext?.restore());
beforeEach(() => {
  resetVersionCache();
  extra = () => undefined;
  lpLatest = "v2";
});

describe("content.info en zoeken", () => {
  it("info per template; latest wordt omgezet", async () => {
    expect(await alice.api.content.info({ uuid: paper })).toMatchObject({ supported: true, kind: "plugin", directory: "/plugins", gameVersion: "1.21.5", sources: ["modrinth", "hangar"], modpacks: false });
    expect(await alice.api.content.info({ uuid: fab })).toMatchObject({ kind: "mod", directory: "/mods", loaders: ["fabric"], sources: ["modrinth"], modpacks: true });
    expect(await alice.api.content.info({ uuid: vel })).toMatchObject({ kind: "plugin", loaders: ["velocity"], gameVersion: null });
    expect((await alice.api.content.info({ uuid: other })).gameVersion).toBe("1.21.5"); // nieuwste stabiele, rc overgeslagen
  });

  it("zoeken filtert op loader en spelversie, met algemene User-Agent", async () => {
    const r = await alice.api.content.search({ uuid: paper, source: "modrinth", query: "lucky" });
    expect(r).toEqual({ total: 1, hits: [expect.objectContaining({ source: "modrinth", projectId: "LP", name: "LuckPerms", author: "Luck", downloads: 42, iconUrl: "https://cdn.modrinth.com/i.png" })] });
    const url = decodeURIComponent(searchUrls.at(-1)!);
    expect(url).toContain("project_type:plugin");
    expect(url).toContain("categories:paper");
    expect(url).toContain("categories:bukkit");
    expect(url).toContain("versions:1.21.5");
    expect(url).not.toContain("server_side");
    await alice.api.content.search({ uuid: fab, source: "modrinth", query: "" });
    expect(decodeURIComponent(searchUrls.at(-1)!)).toContain("server_side:required");
    expect(decodeURIComponent(searchUrls.at(-1)!)).toContain("[[\"project_type:mod\"]");
    expect(ext.calls.filter((c) => c.url.includes("modrinth")).every((c) => c.headers["user-agent"] === "bssg-panel/1.0")).toBe(true);
    await alice.api.content.search({ uuid: fab, source: "modrinth", query: "pack", modpacks: true });
    const mp = decodeURIComponent(searchUrls.at(-1)!);
    expect(mp).toContain("project_type:modpack");
    expect(mp).not.toContain("versions:");
    await expect(alice.api.content.search({ uuid: paper, source: "modrinth", query: "x", modpacks: true })).rejects.toMatchObject({ message: "MODPACK_NOT_SUPPORTED" });
    const hg = await alice.api.content.search({ uuid: paper, source: "hangar", query: "via" });
    expect(hg.hits[0]).toMatchObject({ source: "hangar", projectId: "ViaVersion", author: "ViaVersion" });
    await expect(alice.api.content.search({ uuid: fab, source: "hangar", query: "x" })).rejects.toMatchObject({ message: "SOURCE_NOT_SUPPORTED" });
  });

  it("rechten: andere gebruiker en subuser zonder files-recht", async () => {
    await expect(bob.api.content.info({ uuid: paper })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await alice.api.subusers.invite({ uuid: paper, who: sub.discordId, permissions: ["files.read"] });
    expect(await sub.api.content.list({ uuid: paper })).toEqual([]);
    await expect(sub.api.content.install({ uuid: paper, source: "modrinth", projectId: "VAULT", withDependencies: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("installeren, bijwerken, verwijderen", () => {
  it("resolve toont afhankelijkheden; installatie met afhankelijkheden schrijft bestanden en records", async () => {
    const r = await alice.api.content.resolve({ uuid: paper, source: "modrinth", projectId: "LP" });
    expect(r).toMatchObject({ versionId: "v2", versionNumber: "5.5", filename: "LuckPerms-5.5.jar", dependencies: [{ projectId: "VAULT", name: "Vault", installed: false }] });
    const done = await alice.api.content.install({ uuid: paper, source: "modrinth", projectId: "LP", withDependencies: true });
    expect(done.map((d) => d.projectId).sort()).toEqual(["LP", "VAULT"]);
    expect(files(paper).get("/plugins/LuckPerms-5.5.jar")).toBe("jar-lp-v2");
    expect(files(paper).get("/plugins/Vault.jar")).toBe("jar-vault");
    const list = await alice.api.content.list({ uuid: paper });
    expect(list.map((l) => [l.name, l.versionNumber, l.kind])).toEqual([["LuckPerms", "5.5", "plugin"], ["Vault", "5.4", "plugin"]]);
    expect((await alice.api.content.resolve({ uuid: paper, source: "modrinth", projectId: "LP" })).dependencies[0]!.installed).toBe(true);
    const [log] = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "server.content.install"));
    expect(log).toBeTruthy();
  });

  it("update: nieuwere versie, oud bestand weg; uninstall verwijdert bestand en record", async () => {
    lpLatest = "v1";
    const [lp] = (await alice.api.content.list({ uuid: paper })).filter((l) => l.projectId === "LP");
    await alice.api.content.update({ uuid: paper, id: lp!.id }); // zet terug naar v1 (nieuwste is nu v1)
    expect(files(paper).has("/plugins/LuckPerms-5.5.jar")).toBe(false);
    expect(files(paper).get("/plugins/LuckPerms-5.4.jar")).toBe("jar-lp-v1");
    expect(await alice.api.content.checkUpdates({ uuid: paper })).toEqual([]);
    lpLatest = "v2";
    expect(await alice.api.content.checkUpdates({ uuid: paper })).toEqual([{ id: lp!.id, versionId: "v2", versionNumber: "5.5" }]);
    const upd = await alice.api.content.update({ uuid: paper, id: lp!.id });
    expect(upd).toMatchObject({ versionId: "v2", filename: "LuckPerms-5.5.jar" });
    expect(files(paper).has("/plugins/LuckPerms-5.4.jar")).toBe(false);
    expect(files(paper).get("/plugins/LuckPerms-5.5.jar")).toBe("jar-lp-v2");

    await alice.api.content.uninstall({ uuid: paper, id: lp!.id });
    expect(files(paper).has("/plugins/LuckPerms-5.5.jar")).toBe(false);
    expect((await alice.api.content.list({ uuid: paper })).map((l) => l.projectId)).toEqual(["VAULT"]);
    await expect(alice.api.content.uninstall({ uuid: paper, id: lp!.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("hash die niet klopt wordt geweigerd: niets geschreven, geen record", async () => {
    await expect(alice.api.content.install({ uuid: paper, source: "modrinth", projectId: "BAD", withDependencies: false })).rejects.toMatchObject({ code: "BAD_GATEWAY", message: expect.stringContaining("HASH_MISMATCH") });
    expect(files(paper).has("/plugins/Bad.jar")).toBe(false);
    expect((await alice.api.content.list({ uuid: paper })).some((l) => l.projectId === "BAD")).toBe(false);
  });

  it("download van een niet-toegestane host wordt geweigerd", async () => {
    extra = (url) => (url.pathname === "/v2/project/VAULT/version" ? { json: [mrVersion("v9", "VAULT", "Vault.jar", "/x", "jar-vault")].map((v) => ({ ...v, files: [{ ...v.files[0], url: "https://evil.example/Vault.jar" }] })) } : undefined);
    await expect(alice.api.content.install({ uuid: paper, source: "modrinth", projectId: "VAULT", withDependencies: false })).rejects.toMatchObject({ message: expect.stringContaining("EXTERNAL_HOST_NOT_ALLOWED") });
  });

  it("onveilige bestandsnaam uit de API wordt geweigerd", async () => {
    extra = (url) => (url.pathname === "/v2/project/VAULT/version" ? { json: [{ ...mrVersion("v9", "VAULT", "../../evil.jar", "/data/VAULT/versions/v1/Vault.jar", "jar-vault") }] } : undefined);
    await expect(alice.api.content.install({ uuid: paper, source: "modrinth", projectId: "VAULT", withDependencies: false })).rejects.toMatchObject({ message: expect.stringContaining("unsafe file name") });
  });

  it("te groot bestand wordt afgekapt", async () => {
    extra = (url) => (url.hostname === "cdn.modrinth.com" && url.pathname.includes("VAULT") ? { body: Buffer.alloc(51 * 1024 * 1024) } : undefined);
    await expect(alice.api.content.install({ uuid: paper, source: "modrinth", projectId: "VAULT", withDependencies: false })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("Hangar: sha256 en redirect", async () => {
    const done = await alice.api.content.install({ uuid: paper, source: "hangar", projectId: "ViaVersion", withDependencies: false });
    expect(done[0]).toMatchObject({ source: "hangar", filename: "ViaVersion-5.0.0.jar" });
    expect(files(paper).get("/plugins/ViaVersion-5.0.0.jar")).toBe("jar-via");
    extra = (url) => (url.pathname === "/api/v1/projects/ViaVersion/versions" ? { json: { result: [{ name: "5.0.1", channel: { name: "Release" }, downloads: { PAPER: { fileInfo: { name: "V.jar", sizeBytes: 1, sha256Hash: "00".repeat(32) }, downloadUrl: "https://hangarcdn.papermc.io/x.jar" } } }] } } : undefined);
    await expect(alice.api.content.install({ uuid: paper, source: "hangar", projectId: "ViaVersion", withDependencies: false })).rejects.toMatchObject({ message: expect.stringContaining("HASH_MISMATCH") });
  });

  it("mods op Fabric gaan naar /mods; Velocity naar /plugins", async () => {
    await alice.api.content.install({ uuid: fab, source: "modrinth", projectId: "FAB", withDependencies: false });
    expect(files(fab).get("/mods/fabulous.jar")).toBe("jar-fab");
    expect((await alice.api.content.list({ uuid: fab }))[0]!.kind).toBe("mod");
  });
});

describe("modpacks (.mrpack)", () => {
  const modFile = (path: string, content: string, over: Record<string, unknown> = {}) => ({ path, hashes: { sha1: "a".repeat(40), sha512: sha("sha512", content) }, env: { client: "required", server: "required" }, downloads: [`https://cdn.modrinth.com/data/PACK${path.replace(/^mods/, "")}`], fileSize: content.length, ...over });
  const pack = (index: Record<string, unknown>, extraEntries: Record<string, string> = {}) =>
    buildZip({ "modrinth.index.json": JSON.stringify({ formatVersion: 1, game: "minecraft", versionId: "1", name: "Mijn pack", dependencies: { minecraft: "1.21.4", "fabric-loader": "0.16.13" }, files: [], ...index }), ...extraEntries });
  // Het pakket komt via Modrinth (binair, zoals in productie bij grote pakketten).
  const viaModrinth = (zip: Buffer) => {
    const hash = sha("sha512", zip);
    extra = (url) => {
      if (url.pathname === "/v2/project/PACK/version") return { json: [{ id: "pv1", project_id: "PACK", files: [{ primary: true, filename: "pack.mrpack", url: "https://cdn.modrinth.com/data/PACK/versions/pv1/pack.mrpack", hashes: { sha512: hash }, size: zip.length }] }] };
      if (url.pathname === "/data/PACK/versions/pv1/pack.mrpack") return { body: zip };
      if (url.pathname === "/data/PACK/a.jar") return { body: "jar-a" };
      if (url.pathname === "/data/PACK/bad.jar") return { body: "jar-other" };
      return undefined;
    };
  };
  const run = (uuid = fab, reinstall = true) => alice.api.content.importModpack({ uuid, source: { type: "modrinth", projectId: "PACK" }, reinstall });
  const writes = (uuid: string) => h.daemon.requests.filter((r) => r.method === "PUT" && r.path.startsWith(`/api/servers/${uuid}/files/contents`));

  it("importeert bestanden en overrides, zet versies en herinstalleert", async () => {
    viaModrinth(pack({ files: [modFile("mods/a.jar", "jar-a"), modFile("mods/client.jar", "zzz", { env: { server: "unsupported" } })] }, { "overrides/config/x.toml": "a=1", "overrides/config/y.toml": "y=1", "server-overrides/config/x.toml": "a=2", "client-overrides/skip.txt": "no" }));
    h.daemon.requests.length = 0;
    const r = await run();
    expect(r).toEqual({ name: "Mijn pack", minecraftVersion: "1.21.4", loaderVersion: "0.16.13", filesInstalled: 1, filesSkipped: 1, overridesApplied: 3, reinstalled: true });
    expect(files(fab).get("/mods/a.jar")).toBe("jar-a");
    expect(files(fab).get("/config/x.toml")).toBe("a=2");
    expect(files(fab).get("/config/y.toml")).toBe("y=1");
    expect(files(fab).has("/skip.txt")).toBe(false);
    expect(files(fab).has("/mods/client.jar")).toBe(false);
    const v = (await alice.api.servers.get({ uuid: fab })).variables;
    expect(v.find((x) => x.key === "MINECRAFT_VERSION")!.value).toBe("1.21.4");
    expect(v.find((x) => x.key === "LOADER_VERSION")!.value).toBe("0.16.13");
    expect(h.daemon.requests.some((q) => q.path === `/api/servers/${fab}/install`)).toBe(true);
  });

  it("pad dat ontsnapt wordt voor ALLE schrijfacties geweigerd", async () => {
    for (const evil of ["../evil.jar", "/etc/passwd", "mods/../../x", "a\\..\\b", "C:/x"]) {
      viaModrinth(pack({ files: [modFile("mods/a.jar", "jar-a"), modFile(evil, "jar-a")] }));
      h.daemon.requests.length = 0;
      await expect(run(), evil).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("PATH_ESCAPES") });
      expect(writes(fab)).toHaveLength(0);
    }
    viaModrinth(pack({}, { "overrides/../../evil.txt": "x" }));
    h.daemon.requests.length = 0;
    await expect(run()).rejects.toMatchObject({ message: expect.stringContaining("PATH_ESCAPES") });
    expect(writes(fab)).toHaveLength(0);
  });

  it("hash van een pakketbestand moet kloppen", async () => {
    viaModrinth(pack({ files: [modFile("mods/bad.jar", "jar-expected", { downloads: ["https://cdn.modrinth.com/data/PACK/bad.jar"] })] }));
    await expect(run()).rejects.toMatchObject({ code: "BAD_GATEWAY", message: expect.stringContaining("HASH_MISMATCH") });
    expect(files(fab).has("/mods/bad.jar")).toBe(false);
  });

  it("download-host buiten de allowlist en niet-Fabric pakketten worden geweigerd", async () => {
    viaModrinth(pack({ files: [modFile("mods/a.jar", "jar-a", { downloads: ["https://evil.example/a.jar"] })] }));
    await expect(run()).rejects.toMatchObject({ message: expect.stringContaining("DOWNLOAD_HOST_NOT_ALLOWED") });
    viaModrinth(pack({ dependencies: { minecraft: "1.21.4", "forge": "52.0.0" } }));
    await expect(run()).rejects.toMatchObject({ message: expect.stringContaining("UNSUPPORTED_LOADER") });
    viaModrinth(Buffer.from("this is not a zip at all, definitely not"));
    await expect(run()).rejects.toMatchObject({ message: expect.stringContaining("BAD_MODPACK") });
  });

  it("alleen op Fabric en alleen voor de eigenaar", async () => {
    await expect(alice.api.content.importModpack({ uuid: paper, source: { type: "modrinth", projectId: "PACK" }, reinstall: false })).rejects.toMatchObject({ message: "MODPACK_NOT_SUPPORTED" });
    await alice.api.subusers.invite({ uuid: fab, who: sub.discordId, permissions: ["files.read", "files.write"] });
    await expect(sub.api.content.importModpack({ uuid: fab, source: { type: "modrinth", projectId: "PACK" }, reinstall: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("versiekiezer", () => {
  it("Paper: versies en builds, een uur gecachet; Fabric: game en loader", async () => {
    const before = ext.calls.length;
    const a = await alice.api.content.versionOptions({ uuid: paper, minecraftVersion: "1.21.5" });
    expect(a.variables).toEqual({ version: "MINECRAFT_VERSION", build: "BUILD", loader: null });
    expect(a.versions).toEqual([{ id: "1.21.6-rc1", stable: false }, { id: "1.21.5", stable: true }, { id: "1.21.4", stable: true }]);
    expect(a.builds).toEqual(["112", "100", "99"]);
    await alice.api.content.versionOptions({ uuid: paper, minecraftVersion: "1.21.5" });
    expect(ext.calls.length - before).toBe(2);
    const f = await alice.api.content.versionOptions({ uuid: fab });
    expect(f.versions.map((v) => v.id)).toEqual(["1.21.5", "1.21.4"]); // snapshot gefilterd
    expect(f.loaderVersions[0]).toEqual({ id: "0.16.14", stable: true });
    expect(f.variables.loader).toBe("LOADER_VERSION");
    await expect(bob.api.content.versionOptions({ uuid: paper })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("bron onbereikbaar geeft een foutmelding, geen crash", async () => {
    resetVersionCache();
    extra = (url) => (url.hostname === "fill.papermc.io" ? { status: 500 } : undefined);
    await expect(alice.api.content.versionOptions({ uuid: paper })).rejects.toMatchObject({ code: "BAD_GATEWAY" });
  });
});
