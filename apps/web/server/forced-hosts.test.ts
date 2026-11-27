import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { applyNetworkToml } from "./lib/velocity-toml";
import { fetchServerByUuid, type ServerAccess } from "./servers-data";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const tpl = (n: string) => readFileSync(join(__dirname, "../../../templates/game", n), "utf8");
const h = useHarness({ env: { NODE_PUBLIC_IP: "203.0.113.10" }, templates: { "game/velocity.yaml": tpl("velocity.yaml"), "game/paper.yaml": tpl("paper.yaml"), "game/fabric.yaml": tpl("fabric.yaml") } });
const limits = { cpuPct: 100, ramMb: 1024, swapMb: 0, diskMb: 1024 };
const TOML = `config-version = "2.7"
bind = "0.0.0.0:25577"

[servers]
lobby = "127.0.0.1:25566"
try = ["lobby"]

[forced-hosts]
# keep me
"lobby.example.com" = [
  "lobby"
]

[advanced]
compression-threshold = 256
`;

let admin: TestUser, alice: TestUser, bob: TestUser;
let proxy = "", proxy2 = "", smp = "", creative = "", fab = "", bobs = "";
const create = async (name: string, owner: TestUser, slug: string, port: number) => {
  const a = await h.allocation(port);
  return (await admin.api.admin.servers.create({ name, ownerId: owner.id, nodeId: h.localNodeId, templateId: await h.templateId(slug), limits, allocationIds: [a], variables: {}, startOnInstall: false })).uuid;
};
const toml = (u = proxy) => h.daemon.fs(u).files.get("/velocity.toml")!;
const sid = async (uuid: string) => (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid)))[0]!.id;
const members = () => [
  { serverUuid: smp, name: "smp", isDefault: true },
  { serverUuid: creative, name: "creative", isDefault: false },
  { serverUuid: fab, name: "modded", isDefault: false },
];

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  alice = await h.user({ discordId: "290000000000000071", name: "alice" });
  bob = await h.user({ discordId: "290000000000000072", name: "bob" });
  proxy = await create("Proxy", alice, "velocity", 34700);
  smp = await create("SMP", alice, "paper", 34701);
  creative = await create("Creative", alice, "paper", 34702);
  fab = await create("Fab", alice, "fabric", 34703);
  proxy2 = await create("Proxy 2", alice, "velocity", 34704);
  bobs = await create("Bobs", bob, "paper", 34705);
  h.daemon.fs(proxy).files.set("/velocity.toml", TOML);
  h.daemon.fs(proxy2).files.set("/velocity.toml", TOML);
}, 180_000);

describe("velocity.toml [forced-hosts]", () => {
  it("vervangt de sleutels (ook meerregelig), houdt commentaar en de rest", () => {
    const out = applyNetworkToml(TOML, [{ name: "smp", address: "a:1" }, { name: "creative", address: "b:2" }], [
      { hostname: "survival.example.com", servers: ["smp"] },
      { hostname: "build.example.com", servers: ["creative"] },
    ]);
    expect(out).toContain('[forced-hosts]\n"survival.example.com" = ["smp"]\n"build.example.com" = ["creative"]\n# keep me\n\n[advanced]');
    expect(out).not.toContain("lobby.example.com");
    expect(out).toContain('try = ["smp", "creative"]');
    expect(out).toContain("compression-threshold = 256");
  });
  it("zonder forced-lijst blijft de sectie; leeg maakt hem leeg; onbekende servers vallen weg", () => {
    expect(applyNetworkToml(TOML, [{ name: "lobby", address: "a:1" }])).toContain('"lobby.example.com" = [');
    const empty = applyNetworkToml(TOML, [{ name: "lobby", address: "a:1" }], []);
    expect(empty).toContain("[forced-hosts]\n# keep me\n\n[advanced]");
    expect(applyNetworkToml(TOML, [{ name: "a", address: "a:1" }], [{ hostname: "x.example.com", servers: ["gone"] }])).not.toContain("x.example.com");
  });
  it("voegt de sectie toe als hij ontbreekt", () => {
    const out = applyNetworkToml('bind = "x"\n\n[servers]\ntry = []\n', [{ name: "a", address: "a:1" }], [{ hostname: "a.example.com", servers: ["a"] }]);
    expect(out).toMatch(/\[servers\]\na = "a:1"\ntry = \["a"\]\n\n\[forced-hosts\]\n"a\.example\.com" = \["a"\]\n$/);
  });
});

describe("servers.updateNetwork met forced hosts", () => {
  it("opslaan: velocity.toml, DB en servers.get; try blijft de standaard", async () => {
    await alice.api.servers.updateNetwork({
      uuid: proxy,
      members: members(),
      forcedHosts: [{ hostname: "survival.example.com", serverUuid: smp }, { hostname: "build.example.com", serverUuid: creative }, { hostname: "mods.example.com", serverUuid: fab }],
      restart: false,
    });
    const t = toml();
    expect(t).toContain('try = ["smp", "creative", "modded"]');
    expect(t).toContain('"survival.example.com" = ["smp"]\n"build.example.com" = ["creative"]\n"mods.example.com" = ["modded"]');
    expect(t).not.toContain("lobby.example.com");
    const net = (await alice.api.servers.get({ uuid: proxy })).network;
    expect(net.forcedHosts).toEqual([
      { hostname: "build.example.com", serverUuid: creative },
      { hostname: "mods.example.com", serverUuid: fab },
      { hostname: "survival.example.com", serverUuid: smp },
    ]);
  });

  it("weggelaten forcedHosts: blijven staan; hernoemen van een lid volgt mee", async () => {
    await alice.api.servers.updateNetwork({ uuid: proxy, members: members().map((m) => (m.name === "smp" ? { ...m, name: "survival" } : m)), restart: false });
    expect(toml()).toContain('"survival.example.com" = ["survival"]');
    expect((await alice.api.servers.get({ uuid: proxy })).network.forcedHosts).toHaveLength(3);
  });

  it("lid verwijderen haalt zijn forced hosts weg", async () => {
    await alice.api.servers.updateNetwork({ uuid: proxy, members: members().filter((m) => m.serverUuid !== fab), restart: false });
    expect(toml()).not.toContain("mods.example.com");
    expect((await alice.api.servers.get({ uuid: proxy })).network.forcedHosts.map((f) => f.hostname)).toEqual(["build.example.com", "survival.example.com"]);
  });

  it("validatie: ongeldige naam, dubbel, geen lid, van een andere proxy of van een vreemd domein", async () => {
    const up = (forcedHosts: Array<{ hostname: string; serverUuid: string }>, uuid = proxy) => alice.api.servers.updateNetwork({ uuid, members: uuid === proxy ? members() : [{ serverUuid: bobs, name: "b", isDefault: true }], forcedHosts, restart: false });
    for (const bad of ["*.example.com", "Survival.Example.com", "nodot", "a b.example.com", "-x.example.com", "x.example.com:25565"]) {
      await expect(up([{ hostname: bad, serverUuid: smp }])).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(up([{ hostname: "a.example.com", serverUuid: smp }, { hostname: "a.example.com", serverUuid: creative }])).rejects.toThrow(/FORCED_HOST_DUPLICATE/);
    await expect(up([{ hostname: "a.example.com", serverUuid: bobs }])).rejects.toThrow(/FORCED_HOST_NOT_MEMBER/);
    await expect(up([{ hostname: "a.example.com", serverUuid: proxy }])).rejects.toThrow(/FORCED_HOST_NOT_MEMBER/);
    // hostnaam van een andere proxy
    await admin.api.servers.updateNetwork({ uuid: proxy2, members: [{ serverUuid: bobs, name: "b", isDefault: true }], forcedHosts: [{ hostname: "bob.example.com", serverUuid: bobs }], restart: false });
    await expect(up([{ hostname: "bob.example.com", serverUuid: smp }])).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("FORCED_HOST_TAKEN") });
    // domein van een server buiten het netwerk
    await getDb().insert(schema.domains).values({ serverId: await sid(bobs), hostname: "bobsite.example.com", protocol: "minecraft" });
    await expect(up([{ hostname: "bobsite.example.com", serverUuid: smp }])).rejects.toMatchObject({ code: "CONFLICT" });
    // niets veranderd
    expect((await alice.api.servers.get({ uuid: proxy })).network.forcedHosts).toHaveLength(2);
  });

  it("rechten: alleen eigenaar of admin van de proxy", async () => {
    await expect(bob.api.servers.updateNetwork({ uuid: proxy, members: [], forcedHosts: [], restart: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await alice.api.servers.get({ uuid: proxy })).network.forcedHosts).toHaveLength(2);
  });

  it("suggesties: minecraft-domeinen van proxy en leden; SRV van een forced-host-domein wijst naar de proxy", async () => {
    await getDb().insert(schema.domains).values([
      { serverId: await sid(proxy), hostname: "play.example.com", protocol: "minecraft" },
      { serverId: await sid(smp), hostname: "survival.example.com", protocol: "minecraft" },
      { serverId: await sid(creative), hostname: "creative-site.example.com", protocol: "http" },
    ]);
    const net = (await alice.api.servers.get({ uuid: proxy })).network;
    expect(net.forcedHostSuggestions).toEqual([
      { hostname: "play.example.com", serverUuid: proxy },
      { hostname: "survival.example.com", serverUuid: smp },
    ]);
    const { mcPort } = await import("./routers/domains");
    const access = async (uuid: string) => ({ bundle: (await fetchServerByUuid(uuid))! }) as ServerAccess;
    expect(await mcPort({ hostname: "survival.example.com" }, await access(smp))).toBe(34700); // forced host → proxy
    expect(await mcPort({ hostname: "other.example.com" }, await access(smp))).toBe(34701); // gewoon domein → eigen poort
  });

  it("proxy of backend verwijderen ruimt forced hosts op", async () => {
    await admin.api.admin.servers.delete({ uuid: creative });
    expect((await alice.api.servers.get({ uuid: proxy })).network.forcedHosts.map((f) => f.hostname)).toEqual(["survival.example.com"]);
    await admin.api.admin.servers.delete({ uuid: proxy });
    expect((await getDb().select().from(schema.networkForcedHosts)).map((r) => r.hostname)).toEqual(["bob.example.com"]);
  });
});
