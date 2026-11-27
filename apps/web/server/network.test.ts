import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { applyNetworkToml } from "./lib/velocity-toml";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const tpl = (n: string) => readFileSync(join(__dirname, "../../../templates/game", n), "utf8");
const h = useHarness({ env: { NODE_PUBLIC_IP: "203.0.113.10" }, templates: { "game/velocity.yaml": tpl("velocity.yaml"), "game/paper.yaml": tpl("paper.yaml"), "game/fabric.yaml": tpl("fabric.yaml") } });
const limits = { cpuPct: 100, ramMb: 1024, swapMb: 0, diskMb: 1024 };
const TOML = `# Config version. Do not change this
config-version = "2.7"
bind = "0.0.0.0:25577"
player-info-forwarding-mode = "none"

[servers]
# keep this comment
lobby = "127.0.0.1:25566"
try = [
  "lobby"
]

[forced-hosts]
"example.com" = ["lobby"]
`;

let admin: TestUser, alice: TestUser, bob: TestUser;
let proxy = "", lobby = "", survival = "", bobs = "", fab = "";
const create = async (name: string, owner: TestUser, slug: string, port: number, ip = "127.0.0.1") => {
  const a = await h.allocation(port, ip);
  return (await admin.api.admin.servers.create({ name, ownerId: owner.id, nodeId: h.localNodeId, templateId: await h.templateId(slug), limits, allocationIds: [a], variables: {}, startOnInstall: false })).uuid;
};
const vars = async (uuid: string) => h.daemon.servers.get(uuid)!.spec.environment;
const files = (uuid: string) => h.daemon.fs(uuid).files;
const power = (uuid: string) => h.daemon.requests.filter((r) => r.path === `/api/servers/${uuid}/power`).map((r) => (r.body as { action: string }).action);
const setRunning = (...u: string[]) => u.forEach((x) => (h.daemon.servers.get(x)!.state = "online"));

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  alice = await h.user({ discordId: "290000000000000011", name: "alice" });
  bob = await h.user({ discordId: "290000000000000012", name: "bob" });
  proxy = await create("Proxy", alice, "velocity", 34200, "0.0.0.0");
  lobby = await create("Lobby Server", alice, "paper", 34201);
  survival = await create("Survival", alice, "paper", 34202, "0.0.0.0");
  bobs = await create("Bobs", bob, "paper", 34203);
  fab = await create("Fab", alice, "fabric", 34204);
  files(proxy).set("/velocity.toml", TOML);
}, 180_000);

describe("velocity.toml", () => {
  it("vervangt servers en try, houdt de rest en commentaar", () => {
    const out = applyNetworkToml(TOML, [{ name: "a", address: "1.2.3.4:25565" }, { name: "b", address: "1.2.3.4:25566" }]);
    expect(out).toContain('player-info-forwarding-mode = "modern"');
    expect(out).toContain('[servers]\na = "1.2.3.4:25565"\nb = "1.2.3.4:25566"\ntry = ["a", "b"]\n# keep this comment');
    expect(out).not.toContain("lobby = ");
    expect(out).toContain('config-version = "2.7"');
    expect(out).toContain('[forced-hosts]\n"example.com"');
    expect(applyNetworkToml(out, [{ name: "a", address: "1.2.3.4:25565" }])).not.toContain("b = ");
  });
  it("voegt ontbrekende sectie en modus toe", () => {
    const out = applyNetworkToml('bind = "x"\n', [{ name: "a", address: "1.1.1.1:1" }]);
    expect(out).toContain('player-info-forwarding-mode = "modern"');
    expect(out).toContain('[servers]\na = "1.1.1.1:1"\ntry = ["a"]');
  });
});

describe("servers.updateNetwork", () => {
  it("kandidaten: eigen paper- en fabric-servers (met forwarding-variabelen), geen proxies", async () => {
    const c = await alice.api.servers.networkCandidates({ uuid: proxy });
    expect(c.map((x) => x.uuid).sort()).toEqual([lobby, survival, fab].sort());
    expect(c.find((x) => x.uuid === lobby)).toMatchObject({ suggestedName: "lobby-server", address: "127.0.0.1:34201", takenBy: null });
    expect(c.find((x) => x.uuid === survival)!.address).toBe("203.0.113.10:34202");
    expect((await admin.api.servers.networkCandidates({ uuid: proxy })).map((x) => x.uuid)).toContain(bobs);
  });

  it("opslaan: secret, velocity.toml, backend-variabelen en herstart", async () => {
    setRunning(proxy, lobby); // survival blijft uit
    h.daemon.requests.length = 0;
    const r = await alice.api.servers.updateNetwork({
      uuid: proxy,
      members: [{ serverUuid: survival, name: "survival", isDefault: false }, { serverUuid: lobby, name: "lobby", isDefault: true }],
      restart: true,
    });
    const toml = files(proxy).get("/velocity.toml")!;
    // Op het gedeelde netwerk van de proxy: containernaam + poort (ook voor een allocation op 127.0.0.1).
    expect(toml).toContain(`lobby = "panel-${lobby}:34201"\nsurvival = "panel-${survival}:34202"\ntry = ["lobby", "survival"]`);
    expect(h.daemon.proxyNetworks.get(proxy)).toEqual([lobby, survival]);
    expect(toml).toContain('player-info-forwarding-mode = "modern"');
    expect(toml).toContain("# keep this comment");
    const secret = (await alice.api.servers.get({ uuid: proxy })).variables.find((v) => v.key === "VELOCITY_FORWARDING_SECRET")!.value;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{12,128}$/);
    for (const u of [lobby, survival]) {
      const env = await vars(u);
      expect(env.VELOCITY_FORWARDING).toBe("true");
      expect(env.VELOCITY_SECRET).toBe(secret);
    }
    expect((await vars(proxy)).VELOCITY_FORWARDING_SECRET).toBe(secret);
    expect(r.servers.map((s) => [s.name, s.role, s.restarted])).toEqual([["Lobby Server", "backend", true], ["Survival", "backend", false], ["Proxy", "proxy", true]]);
    expect(r.servers.every((s) => !s.reloaded)).toBe(true); // eerste keer: nieuwe secret + forwarding-modus, dus herstart
    expect(power(lobby)).toEqual(["restart"]);
    expect(power(survival)).toEqual([]);
    expect(power(proxy)).toEqual(["restart"]);

    const d = await alice.api.servers.get({ uuid: proxy });
    expect(d.network).toMatchObject({ role: "proxy", connectAddress: "203.0.113.10:34200" });
    expect(d.network.members.map((m) => [m.name, m.isDefault])).toEqual([["lobby", true], ["survival", false]]);
    expect((await alice.api.servers.get({ uuid: lobby })).network).toMatchObject({ role: "backend", proxy: { uuid: proxy, name: "Proxy" } });
    const [log] = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "server.network.update"));
    expect(log).toBeTruthy();
  });

  it("het secret blijft bij opnieuw opslaan gelijk; minecraft-domein wordt het verbindingsadres", async () => {
    const before = (await alice.api.servers.get({ uuid: proxy })).variables.find((v) => v.key === "VELOCITY_FORWARDING_SECRET")!.value;
    await alice.api.servers.updateNetwork({ uuid: proxy, members: [{ serverUuid: lobby, name: "main", isDefault: true }, { serverUuid: survival, name: "survival", isDefault: false }], restart: false });
    expect((await alice.api.servers.get({ uuid: proxy })).variables.find((v) => v.key === "VELOCITY_FORWARDING_SECRET")!.value).toBe(before);
    await getDb().insert(schema.domains).values({ serverId: (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, proxy)))[0]!.id, hostname: "play.mc.test", protocol: "minecraft" });
    expect((await alice.api.servers.get({ uuid: proxy })).network.connectAddress).toBe("play.mc.test");
  });

  it("zelfde leden opnieuw opslaan met draaiende proxy: alleen `velocity reload`, niets herstart", async () => {
    setRunning(proxy, lobby);
    h.daemon.requests.length = 0;
    const r = await alice.api.servers.updateNetwork({ uuid: proxy, members: [{ serverUuid: lobby, name: "main", isDefault: true }, { serverUuid: survival, name: "survival", isDefault: false }], restart: true });
    expect(power(proxy)).toEqual([]);
    expect(power(lobby)).toEqual([]);
    expect(r.servers.map((s) => [s.role, s.restarted, s.reloaded])).toEqual([["backend", false, false], ["backend", false, false], ["proxy", false, true]]);
    const cmds = h.daemon.requests.filter((q) => q.path === `/api/servers/${proxy}/commands`).map((q) => (q.body as { commands: string[] }).commands);
    expect(cmds).toEqual([["velocity reload"]]);
  });

  it("lid verwijderen zet de backend terug en laat de rest staan", async () => {
    await alice.api.servers.updateNetwork({ uuid: proxy, members: [{ serverUuid: lobby, name: "main", isDefault: true }], restart: false });
    const env = await vars(survival);
    expect(env.VELOCITY_FORWARDING).toBe("false");
    expect(env.VELOCITY_SECRET).toBe("");
    const toml = files(proxy).get("/velocity.toml")!;
    expect(toml).toContain(`main = "panel-${lobby}:34201"\ntry = ["main"]`);
    expect(toml).not.toContain("survival =");
    expect(h.daemon.proxyNetworks.get(proxy)).toEqual([lobby]);
    expect((await alice.api.servers.get({ uuid: survival })).network.role).toBe("none");
  });

  it("daemon zonder PUT /network (oude versie): adressen via de host, zoals vroeger", async () => {
    h.daemon.proxyNetworkUnsupported = true;
    try {
      await alice.api.servers.updateNetwork({ uuid: proxy, members: [{ serverUuid: lobby, name: "main", isDefault: true }, { serverUuid: survival, name: "survival", isDefault: false }], restart: false });
      expect(files(proxy).get("/velocity.toml")!).toContain('main = "127.0.0.1:34201"\nsurvival = "203.0.113.10:34202"');
    } finally {
      h.daemon.proxyNetworkUnsupported = false;
    }
    await alice.api.servers.updateNetwork({ uuid: proxy, members: [{ serverUuid: lobby, name: "main", isDefault: true }], restart: false });
    expect(files(proxy).get("/velocity.toml")!).toContain(`main = "panel-${lobby}:34201"\ntry = ["main"]`);
  });

  it("geen subnetten meer / andere daemonfout: niets opgeslagen", async () => {
    h.daemon.override = (r) => (r.path === `/api/servers/${proxy}/network` ? { status: 500, body: { error: "internal", message: "no free /26 subnet left" } } : undefined);
    try {
      await expect(alice.api.servers.updateNetwork({ uuid: proxy, members: [{ serverUuid: survival, name: "survival", isDefault: true }], restart: false })).rejects.toThrow();
    } finally {
      h.daemon.override = null;
    }
    expect(files(proxy).get("/velocity.toml")!).toContain(`main = "panel-${lobby}:34201"\ntry = ["main"]`);
    expect((await alice.api.servers.get({ uuid: survival })).network.role).toBe("none");
  });

  it("rechten en validatie", async () => {
    const m = (u: string, name = "x", isDefault = true) => [{ serverUuid: u, name, isDefault }];
    await expect(alice.api.servers.updateNetwork({ uuid: proxy, members: m(bobs), restart: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(bob.api.servers.updateNetwork({ uuid: proxy, members: [], restart: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(alice.api.servers.updateNetwork({ uuid: lobby, members: [], restart: false })).rejects.toMatchObject({ message: "NOT_A_PROXY" });
    await expect(alice.api.servers.updateNetwork({ uuid: proxy, members: m(await create("Proxy 3", alice, "velocity", 34206)), restart: false })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(alice.api.servers.updateNetwork({ uuid: proxy, members: m(survival, "Bad Name"), restart: false })).rejects.toThrow();
    await expect(alice.api.servers.updateNetwork({ uuid: proxy, members: m(survival, "x", false), restart: false })).rejects.toMatchObject({ message: "NETWORK_NEEDS_ONE_DEFAULT" });
    await expect(alice.api.servers.networkCandidates({ uuid: lobby })).rejects.toMatchObject({ message: "NOT_A_PROXY" });
    // admin mag een server van een ander kiezen
    await admin.api.servers.updateNetwork({ uuid: proxy, members: [...m(lobby, "main"), { serverUuid: bobs, name: "bobs", isDefault: false }], restart: false });
    expect((await admin.api.servers.get({ uuid: bobs })).network.role).toBe("backend");
  });

  it("een backend hoort bij één proxy; verwijderen ruimt de relatie op", async () => {
    const proxy2 = await create("Proxy 2", alice, "velocity", 34205);
    files(proxy2).set("/velocity.toml", TOML);
    const c = await alice.api.servers.networkCandidates({ uuid: proxy2 });
    expect(c.find((x) => x.uuid === lobby)!.takenBy).toBe("Proxy");
    await expect(alice.api.servers.updateNetwork({ uuid: proxy2, members: [{ serverUuid: lobby, name: "main", isDefault: true }], restart: false })).rejects.toMatchObject({ code: "CONFLICT" });
    // backend verwijderen
    await admin.api.admin.servers.delete({ uuid: lobby });
    expect((await alice.api.servers.get({ uuid: proxy })).network.members.map((x) => x.serverUuid)).toEqual([bobs]);
    // proxy verwijderen
    await admin.api.admin.servers.delete({ uuid: proxy });
    expect((await vars(bobs)).VELOCITY_FORWARDING).toBe("false");
    expect((await vars(bobs)).VELOCITY_SECRET).toBe("");
    expect(await getDb().select().from(schema.networkMembers)).toEqual([]);
    expect((await bob.api.servers.get({ uuid: bobs })).network.role).toBe("none");
  });
});
